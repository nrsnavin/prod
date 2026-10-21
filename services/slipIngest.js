'use strict';
// ══════════════════════════════════════════════════════════════════
//  PRODUCTION SLIPS FROM A PHOTO
//
//  A supervisor photographs the shift's production record and sends it
//  to the factory's WhatsApp number (or uploads it on the web). This:
//
//    1. keeps the photos and queues the reading (outbox "slip.read"),
//       so the WhatsApp webhook answers inside Twilio's time limit;
//    2. reads them (utils/slipOcr.js) — the app's printed sheet or the
//       factory's own slip;
//    3. works out which shift they belong to, from the database, never
//       from a guess:
//         plan number on a printed sheet  >  the printed row codes  >
//         a caption ("DAY 06-10")  >  the date/shift written on the slip;
//       and if none of those, asks;
//    4. matches each row to a shift entry (by printed code, or by
//       machine number within that shift's plan), and marks anything
//       doubtful for a person to check;
//    5. waits. "OK <code>" on WhatsApp saves the rows that are clear;
//       the web review screen can correct and save the rest.
//
//  A floor sheet (utils/floorSheetPdf.js) is printed with no plan. When
//  its shift still has none, the slip waits as needs_plan with the plan
//  the sheet proposes — each machine, the operator written against it
//  matched to an employee by name. Creating that plan (web, or "OK" on
//  WhatsApp for the operators that matched) re-reads the slip against
//  it, and the figures written become the shift's production draft.
//
//  Saving goes through services/shiftSubmit.js, the same path as a
//  worker's own entry: values become a SUBMISSION, pending verification.
//  A supervisor still verifies every entry before it reaches the job.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const axios = require('axios');
const moment = require('moment');

const SlipIngest = require('../models/SlipIngest');
const SlipPhoto = require('../models/SlipPhoto');
const ShiftPlan = require('../models/ShiftPlan');
const ShiftDetail = require('../models/ShiftDetail');
// Registered for the populates below, whatever has been loaded before.
require('../models/Machine');
require('../models/JobOrder');
const User = require('../models/User');
const Employee = require('../models/Employee');
const NotificationSettings = require('../models/NotificationSettings');
const ErrorHandler = require('../utils/ErrorHandler');
const { readSlip, SUPPORTED_TYPES } = require('../utils/slipOcr');
const { shortCode } = require('../utils/shiftSheetPdf');
const { normalisePhone } = require('../utils/workerLogin');
const { isSelfServiceOnly } = require('../utils/features');
const { promptVersion } = require('../utils/aiPrompts');
const { enqueue } = require('../utils/outbox');
const { sendWhatsApp } = require('../utils/whatsapp');
const { submitProduction } = require('./shiftSubmit');
const { createShiftPlan } = require('./shiftPlanCreate');
const Machine = require('../models/Machine');
const { levenshtein } = require('../utils/fuzzyMatch');
const ledger = require('./aiLedger');

const SURFACE = 'production-slip-ocr';
const MAX_READ_ATTEMPTS = 3;
const LOW_CONFIDENCE = 0.75;
const MAX_RUN_MINUTES = 12 * 60;
const APPLY_LEASE_MS = 5 * 60 * 1000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// ── Small parsers ────────────────────────────────────────────────

/**
 * Date and shift from a caption or a reply: "DAY 06-10", "night 6/10/26",
 * "N 06.10.2026". Either part may be missing. Dates are day first; a
 * missing year is this year (last year if that would be in the future).
 */
function parseDateShift(text, now = new Date()) {
  const s = String(text || '').trim();
  let shift = null;
  if (/\b(day|d)\b/i.test(s)) shift = 'DAY';
  if (/\b(night|n)\b/i.test(s)) shift = shift ? null : 'NIGHT'; // both named: ambiguous

  let dateKey = null;
  const m = s.match(/\b(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?\b/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = m[3] ? Number(m[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = moment({ year, month: month - 1, day });
    if (d.isValid() && d.date() === day) {
      if (!m[3] && d.isAfter(moment(now).add(2, 'days'))) d.subtract(1, 'year');
      dateKey = d.format('YYYY-MM-DD');
    }
  }
  return { dateKey, shift };
}

/**
 * A text message about a slip:
 *   OK 4821 / YES 4821 / SAVE 4821     save the clear rows
 *   NO 4821 / CANCEL 4821              drop it
 *   4821 DAY 06-10                     set its date and shift
 */
function parseSlipCommand(text) {
  const s = String(text || '').trim();
  let m = s.match(/^(ok|okay|yes|save)\s+(\d{4})$/i);
  if (m) return { action: 'ok', code: m[2] };
  m = s.match(/^(no|cancel|discard|drop)\s+(\d{4})$/i);
  if (m) return { action: 'no', code: m[2] };
  m = s.match(/^(\d{4})\s+(.+)$/);
  if (m) {
    const { dateKey, shift } = parseDateShift(m[2]);
    if (dateKey && shift) return { action: 'set', code: m[1], dateKey, shift };
  }
  return null;
}

/** "M-07", "m7", "07", "Loom 7" → comparable keys. */
function machineKeys(raw) {
  const alnum = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digits = alnum.match(/\d+/g);
  return {
    alnum: alnum.replace(/^(LOOM|MACHINE|MC|NO)/, ''),
    number: digits ? Number(digits[digits.length - 1]) : null,
  };
}

const shiftLabel = (shift) => (shift === 'NIGHT' ? 'Night' : 'Day');
const dateLabel = (dateKey) => (dateKey ? moment(dateKey, 'YYYY-MM-DD').format('D MMM YYYY') : '');
const runMinutes = (timer) => {
  const m = String(timer || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function webLink(slip) {
  const base = (process.env.WEB_URL || '').replace(/\/+$/, '');
  return base ? `${base}/production-slips/${slip._id}` : null;
}

// ── Who may send slips ───────────────────────────────────────────

let _botUser = null;
async function botUser() {
  if (_botUser) return _botUser;
  const { getWhatsAppBotToken, BOT_EMAIL } = require('../utils/whatsappInbound');
  let bot = await User.findOne({ email: BOT_EMAIL }).select('_id name').lean();
  if (!bot) {
    await getWhatsAppBotToken(); // creates it
    bot = await User.findOne({ email: BOT_EMAIL }).select('_id name').lean();
  }
  _botUser = bot;
  return bot;
}

/**
 * The person behind a WhatsApp number, if they may send slips: a login
 * with production access (admin or production, not a worker's own
 * self-service login) whose employee record has this phone; or a number
 * on the owner's notification list, acting as the WhatsApp bot.
 */
async function slipSender(e164) {
  const phone = normalisePhone(e164);
  if (phone) {
    const employees = await Employee.find({ phoneNumber: { $in: [phone, `+91${phone}`, `0${phone}`, `91${phone}`] } })
      .select('_id').limit(5).lean();
    if (employees.length) {
      const users = await User.find({ employee: { $in: employees.map((e) => e._id) } })
        .select('_id name role employee features').lean();
      const user = users.find((u) => ['admin', 'production'].includes(u.role) && !isSelfServiceOnly(u));
      if (user) return { userId: user._id, name: user.name };
    }
  }
  const settings = await NotificationSettings.load();
  if ((settings.recipients || []).includes(String(e164).trim())) {
    const bot = await botUser();
    return { userId: bot?._id || null, name: `Owner (${e164})` };
  }
  return null;
}

// ── Creating ─────────────────────────────────────────────────────

async function newConfirmCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    const taken = await SlipIngest.exists({ confirmCode: code, status: { $in: SlipIngest.OPEN_STATUSES } });
    if (!taken) return code;
  }
  throw new Error('Could not find a free slip number.');
}

/**
 * A slip that arrived on WhatsApp. Idempotent on Twilio's message id:
 * a retried webhook gets the slip already made.
 */
async function receiveFromWhatsApp({ messageSid, from, caption, media, sender }) {
  if (messageSid) {
    const existing = await SlipIngest.findOne({ messageSid }).lean();
    if (existing) return { slip: existing, duplicate: true };
  }
  const usable = (media || []).filter((m) => m && m.url).slice(0, 10);
  try {
    const slip = await SlipIngest.create({
      source: 'whatsapp',
      messageSid: messageSid || undefined,
      from,
      sentBy: sender.userId,
      sentByName: sender.name,
      caption: String(caption || '').slice(0, 500),
      media: usable.map((m) => ({ url: m.url, contentType: String(m.contentType || '').toLowerCase() })),
      pages: usable.length,
      confirmCode: await newConfirmCode(),
    });
    await enqueue(null, 'slip.read', { slipId: String(slip._id) });
    return { slip: slip.toObject(), duplicate: false };
  } catch (err) {
    if (err?.code === 11000 && messageSid) {
      return { slip: await SlipIngest.findOne({ messageSid }).lean(), duplicate: true };
    }
    throw err;
  }
}

/** A slip uploaded on the web: the photos are here already. */
async function receiveUpload({ files, caption, dateKey, shift, user }) {
  const list = (files || []).filter((f) => f && f.buffer && f.buffer.length);
  if (!list.length) throw new ErrorHandler('Add at least one photo of the slip.', 400);
  if (list.length > 10) throw new ErrorHandler('At most 10 photos per slip.', 400);
  const bad = list.find((f) => !SUPPORTED_TYPES.includes(f.mimetype));
  if (bad) throw new ErrorHandler(`Cannot read a ${bad.mimetype} file. Use JPEG, PNG or PDF.`, 400);

  const slip = await SlipIngest.create({
    source: 'web',
    sentBy: user?._id || null,
    sentByName: user?.name || '',
    // Day first, as a person would type it, so it reads like a caption.
    caption: [caption, shift, dateKey && moment(dateKey, 'YYYY-MM-DD').format('DD-MM-YYYY')]
      .filter(Boolean).join(' ').slice(0, 500),
    pages: list.length,
    confirmCode: await newConfirmCode(),
  });
  await storePhotos(slip._id, list.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })));
  await enqueue(null, 'slip.read', { slipId: String(slip._id) });
  return slip.toObject();
}

async function storePhotos(slipId, pages) {
  const expiresAt = SlipPhoto.expiryFrom();
  for (let i = 0; i < pages.length; i++) {
    await SlipPhoto.updateOne(
      { slip: slipId, page: i },
      { $setOnInsert: {
        slip: slipId, page: i, contentType: pages[i].mimetype,
        size: pages[i].buffer.length, data: pages[i].buffer.toString('base64'), expiresAt,
      } },
      { upsert: true }
    );
  }
}

async function loadPhotos(slipId) {
  const rows = await SlipPhoto.find({ slip: slipId }).select('+data page contentType').sort({ page: 1 }).lean();
  return rows.map((r) => ({ buffer: Buffer.from(r.data, 'base64'), mimetype: r.contentType }));
}

/** Fetch WhatsApp media from Twilio (needs the account's credentials). */
async function downloadMedia(media) {
  const pages = [];
  for (const m of media) {
    const url = new URL(m.url);
    // The URL arrives in the (signed) webhook body; still, only ever
    // fetch from Twilio, with Twilio's credentials.
    if (url.protocol !== 'https:' || !/(^|\.)twilio\.com$/i.test(url.hostname)) {
      throw Object.assign(new Error(`Refusing to fetch media from ${url.hostname}`), { permanent: true });
    }
    const res = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      auth: { username: process.env.TWILIO_ACCOUNT_SID || '', password: process.env.TWILIO_AUTH_TOKEN || '' },
      timeout: 20_000,
      maxContentLength: MAX_PHOTO_BYTES,
      maxRedirects: 3,
    });
    const type = String(res.headers['content-type'] || m.contentType || '').split(';')[0].trim().toLowerCase();
    pages.push({ buffer: Buffer.from(res.data), mimetype: type });
  }
  return pages;
}

// ── Working out the shift ────────────────────────────────────────

/** The plan for a date and shift, matching how the printed sheet names dates. */
async function planFor(dateKey, shift) {
  if (!dateKey || !shift) return null;
  const centre = moment(dateKey, 'YYYY-MM-DD');
  const candidates = await ShiftPlan.find({
    shift,
    date: { $gte: centre.clone().subtract(36, 'hours').toDate(), $lte: centre.clone().add(36, 'hours').toDate() },
  }).lean();
  return candidates.find((p) => moment(p.date).format('YYYY-MM-DD') === dateKey)
    || candidates.find((p) => new Date(p.date).toISOString().slice(0, 10) === dateKey)
    || null;
}

/** A sheet with codes but no readable plan number: the recent plan they belong to. */
async function planFromCodes(codes) {
  const wanted = new Set(codes.map(normCode).filter(Boolean));
  if (!wanted.size) return null;
  const plans = await ShiftPlan.find({ date: { $gte: moment().subtract(30, 'days').toDate() } })
    .sort({ date: -1 }).limit(60).select('date shift plan finalized').lean();
  let best = null;
  for (const p of plans) {
    const hits = (p.plan || []).filter((id) => wanted.has(shortCode(id))).length;
    if (hits && (!best || hits > best.hits)) best = { plan: p, hits };
  }
  return best ? best.plan : null;
}

function normCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const suffix = code.replace(/^SD/, '').slice(-6);
  return suffix.length === 6 ? `SD-${suffix}` : null;
}

/** Decide the plan; returns { plan, dateKey, shift, from } or the reason it cannot. */
async function resolveShift(read, caption, override) {
  if (override?.dateKey && override?.shift) {
    const plan = await planFor(override.dateKey, override.shift);
    return { plan, dateKey: override.dateKey, shift: override.shift, from: 'person' };
  }
  if (read.planNo) {
    const m = read.planNo.match(/^SP-(\d{4})(\d{2})(\d{2})-([DN])$/);
    if (m) {
      const dateKey = `${m[1]}-${m[2]}-${m[3]}`;
      const shift = m[4] === 'N' ? 'NIGHT' : 'DAY';
      const plan = await planFor(dateKey, shift);
      if (plan) return { plan, dateKey, shift, from: 'plan' };
    }
  }
  if (read.sheetNo) {
    // A floor sheet names its own date and shift. It was printed with no
    // plan, so there may still be none — that is for stage() to offer.
    const m = read.sheetNo.match(/^FS-(\d{4})(\d{2})(\d{2})-([DN])$/);
    if (m) {
      const dateKey = `${m[1]}-${m[2]}-${m[3]}`;
      const shift = m[4] === 'N' ? 'NIGHT' : 'DAY';
      return { plan: await planFor(dateKey, shift), dateKey, shift, from: 'sheet' };
    }
  }
  const codes = read.rows.map((r) => r.code).filter(Boolean);
  if (codes.length) {
    const plan = await planFromCodes(codes);
    if (plan) {
      return { plan, dateKey: moment(plan.date).format('YYYY-MM-DD'), shift: plan.shift, from: 'codes' };
    }
  }
  const cap = parseDateShift(caption);
  const dateKey = cap.dateKey || read.date;
  const shift = cap.shift || read.shift;
  if (dateKey && shift) {
    const from = cap.dateKey && cap.shift ? 'caption' : (!cap.dateKey && !cap.shift ? 'slip' : 'caption and slip');
    return { plan: await planFor(dateKey, shift), dateKey, shift, from };
  }
  return { plan: null, dateKey: dateKey || null, shift: shift || null, from: null };
}

// ── Matching rows ────────────────────────────────────────────────

async function planEntries(plan) {
  return ShiftDetail.find({ _id: { $in: plan.plan || [] } })
    .select('_id status machine employee job elastics timer submittedTimer submittedProductionMeters')
    .populate('machine', 'ID NoOfHead')
    .populate('employee', 'name')
    .populate('job', 'jobOrderNo')
    .lean();
}

async function expectedRange(entry, timer) {
  try {
    const { expectForShift } = require('./productionModel');
    const out = await expectForShift(
      { ...entry, machine: entry.machine?._id ?? entry.machine },
      { runTime: timer || undefined }
    );
    const p = out?.prediction;
    return p ? { low: p.checkLow, high: p.checkHigh } : null;
  } catch (_) {
    return null; // the model is a hint; never a reason to fail a slip
  }
}

async function matchRows(read, plan) {
  const entries = await planEntries(plan);
  const byCode = new Map(entries.map((e) => [shortCode(e._id), e]));
  const byAlnum = new Map();
  const byNumber = new Map();
  for (const e of entries) {
    if (!e.machine?.ID) continue;
    const k = machineKeys(e.machine.ID);
    byAlnum.set(k.alnum, e);
    if (k.number != null) byNumber.set(k.number, [...(byNumber.get(k.number) || []), e]);
  }

  const rows = [];
  const unmatched = [];
  const seen = new Set();
  for (const r of read.rows) {
    let entry = r.code ? byCode.get(normCode(r.code)) : null;
    if (!entry && r.machine) {
      const k = machineKeys(r.machine);
      entry = byAlnum.get(k.alnum)
        || (k.number != null && (byNumber.get(k.number) || []).length === 1 ? byNumber.get(k.number)[0] : null);
    }
    if (!entry) {
      unmatched.push({
        code: r.code, machineRead: r.machine, production: r.production, timer: r.timer, remarks: r.remarks,
      });
      continue;
    }

    const notes = [];
    let state = 'ready';
    const check = (note) => { notes.push(note); if (state === 'ready') state = 'check'; };

    if (plan.finalized) { state = 'skip'; notes.push('Shift is finalised'); }
    else if (entry.status === 'closed') { state = 'skip'; notes.push('Already verified'); }
    else if (entry.status === 'loading') { state = 'skip'; notes.push('Machine was loading'); }

    if (state !== 'skip') {
      if (seen.has(String(entry._id))) check('Same loom twice on the slip');
      if (r.production == null) check('Metres not readable');
      if (r.confidence != null && r.confidence < LOW_CONFIDENCE) check('Handwriting unclear');
      const mins = runMinutes(r.timer);
      if (mins != null && mins > MAX_RUN_MINUTES) check('Run time over 12 hours');
      if (entry.status === 'pending_verification' && entry.submittedProductionMeters != null
          && r.production != null && entry.submittedProductionMeters !== r.production) {
        check(`Already entered as ${entry.submittedProductionMeters} m`);
      }
    }
    seen.add(String(entry._id));

    let expected = null;
    if (state !== 'skip' && r.production != null) {
      expected = await expectedRange(entry, r.timer);
      if (expected && (r.production < expected.low || r.production > expected.high)) {
        check(`Far from usual (${Math.round(expected.low)}–${Math.round(expected.high)} m a head)`);
      }
    }

    rows.push({
      shiftDetail: entry._id,
      code: r.code,
      machineRead: r.machine,
      machineID: entry.machine?.ID || null,
      operator: entry.employee?.name || r.operator || null,
      jobNo: entry.job?.jobOrderNo != null ? `J-${entry.job.jobOrderNo}` : null,
      production: r.production,
      timer: r.timer,
      remarks: r.remarks || '',
      confidence: r.confidence,
      state,
      notes,
      expected: expected || { low: null, high: null },
    });
  }
  return { rows, unmatched };
}

// ── Reading (outbox "slip.read") ─────────────────────────────────

/**
 * Read a slip and stage it. Runs from the outbox, so a transient
 * failure (network, the AI service busy) is retried; after a few tries,
 * or for a failure retrying cannot fix, the slip is marked failed and
 * the sender told.
 */
async function readSlipJob(slipId) {
  const slip = await SlipIngest.findOneAndUpdate(
    { _id: slipId, status: { $in: ['received', 'reading'] } },
    { $set: { status: 'reading' }, $inc: { readAttempts: 1 } },
    { new: true }
  ).select('+media');
  if (!slip) return { skipped: 'not waiting to be read' };

  let pages;
  let read;
  const startedAt = Date.now();
  try {
    if (slip.media?.length) {
      pages = await downloadMedia(slip.media);
      await storePhotos(slip._id, pages);
      await SlipIngest.updateOne({ _id: slip._id }, { $set: { media: [] } });
    } else {
      pages = await loadPhotos(slip._id);
    }
    read = await readSlip(pages);
  } catch (err) {
    const permanent = err.permanent || ['UNSUPPORTED_TYPE', 'TOO_MANY_PAGES', 'NO_PAGES', 'ANTHROPIC_KEY_MISSING']
      .includes(err.code) || err?.response?.status === 404;
    if (!permanent && slip.readAttempts < MAX_READ_ATTEMPTS) {
      await SlipIngest.updateOne({ _id: slip._id, status: 'reading' }, { $set: { status: 'received' } });
      throw err; // the outbox retries
    }
    await ledger.record({
      surface: SURFACE, model: 'unknown', promptVersion: promptVersion(SURFACE),
      refType: 'SlipIngest', refId: slip._id, latencyMs: Date.now() - startedAt, error: err.message,
    });
    const problem = err.code === 'ANTHROPIC_KEY_MISSING'
      ? 'Reading photos is not set up on the server yet.'
      : err.code === 'UNSUPPORTED_TYPE' || err.code === 'TOO_MANY_PAGES' ? err.message
        : 'The photo could not be fetched or read. Please send it again.';
    const failed = await SlipIngest.findOneAndUpdate(
      { _id: slip._id, status: 'reading' },
      { $set: { status: 'failed', problem } },
      { new: true }
    );
    if (failed) await tellSender(failed);
    return { failed: problem };
  }

  const staged = await stage(slip, read, null);
  // Keyed by shift entry, like what is saved (services/shiftSubmit.js),
  // so the ledger can compare each row field by field.
  staged.suggestion = await ledger.record({
    surface: SURFACE,
    model: read.model,
    promptVersion: promptVersion(SURFACE),
    refType: 'SlipIngest',
    refId: slip._id,
    proposed: {
      format: read.format, planNo: read.planNo, date: read.date, shift: read.shift,
      rows: Object.fromEntries(staged.rows.map((r) => [String(r.shiftDetail), {
        production: r.production, timer: r.timer, remarks: r.remarks,
      }])),
      unmatched: staged.unmatched.length,
    },
    latencyMs: read.latencyMs,
    usage: read.usage,
  });
  staged.readAt = new Date();
  const saved = await SlipIngest.findOneAndUpdate(
    { _id: slip._id, status: 'reading' },
    { $set: staged },
    { new: true }
  );
  if (saved) await tellSender(saved);
  return { status: saved?.status };
}

/** Everything that depends on the read and the shift, ready to $set. */
async function stage(slip, fullRead, override) {
  const base = { read: fullRead, format: fullRead.format, rows: [], unmatched: [], planDraft: [] };
  // A floor sheet lists every machine; the ones nobody wrote on (free
  // looms, mostly) are not part of the shift.
  const read = fullRead.format === 'floor'
    ? { ...fullRead, rows: fullRead.rows.filter((r) => !blankRow(r)) }
    : fullRead;
  if (fullRead.format === 'floor' && fullRead.rows.length && !read.rows.length) {
    return {
      ...base, status: 'failed', shiftPlan: null, dateKey: null, shift: null, dateFrom: null,
      problem: 'Nothing is written on the sheet yet: no operator, timer or metres on any row.',
    };
  }
  if (!read.rows.length) {
    return {
      ...base, status: 'failed', shiftPlan: null, dateKey: null, shift: null, dateFrom: null,
      problem: read.problem === 'not_a_slip'
        ? 'This does not look like a production slip.'
        : 'The photo could not be read. Take it again in good light, flat, with the whole slip in view.',
    };
  }
  const where = await resolveShift(read, slip.caption, override);
  const common = { ...base, dateKey: where.dateKey, shift: where.shift, dateFrom: where.from };
  if (!where.dateKey || !where.shift) {
    return {
      ...common, status: 'failed', shiftPlan: null,
      problem: 'The date and shift could not be told from the slip.',
    };
  }
  if (!where.plan) {
    const planDraft = await draftPlan(read.rows);
    if (planDraft.some((r) => r.machine)) {
      return {
        ...common, status: 'needs_plan', shiftPlan: null, planDraft,
        problem: `There is no ${shiftLabel(where.shift).toLowerCase()} shift plan for ${dateLabel(where.dateKey)} yet. `
          + 'Check the operators read from the sheet and create the plan from it.',
      };
    }
    return {
      ...common, status: 'failed', shiftPlan: null,
      problem: `There is no ${shiftLabel(where.shift).toLowerCase()} shift plan for ${dateLabel(where.dateKey)}.`,
    };
  }
  const { rows, unmatched } = await matchRows(read, where.plan);
  if (!rows.length) {
    return {
      ...common, status: 'failed', shiftPlan: where.plan._id, rows, unmatched,
      problem: `None of the looms on the slip are in the ${shiftLabel(where.shift).toLowerCase()} shift plan for ${dateLabel(where.dateKey)}.`,
    };
  }
  return { ...common, status: 'ready', problem: null, shiftPlan: where.plan._id, rows, unmatched };
}

/** A person said which date and shift: match again against that plan. */
async function setShift(slipId, { dateKey, shift }) {
  const slip = await SlipIngest.findById(slipId);
  if (!slip) throw new ErrorHandler('Slip not found', 404);
  if (!['ready', 'failed', 'needs_plan'].includes(slip.status) || !slip.read) {
    throw new ErrorHandler(`This slip is ${slip.status}; its shift cannot be changed now.`, 409);
  }
  if (slip.rows.some((r) => r.applied)) {
    throw new ErrorHandler('Some rows are already saved against the current shift.', 409);
  }
  const staged = await stage(slip, slip.read, { dateKey, shift });
  const saved = await SlipIngest.findOneAndUpdate(
    { _id: slip._id, status: slip.status, __v: slip.__v },
    { $set: staged, $inc: { __v: 1 } },
    { new: true }
  );
  if (!saved) throw new ErrorHandler('The slip changed just now. Reload and try again.', 409);
  return saved;
}

// ── A plan from a sheet, when the shift has none ─────────────────

/** Nothing written on a floor-sheet row. */
const blankRow = (r) => !r.operator && r.production == null && !r.timer && !r.remarks;

const foldName = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The employee a hand-written name means, if it can be told:
 *   exact  the name as on record (case, spacing and dots aside)
 *   close  one candidate only, by first name, initials ("Ravi K") or a
 *          letter or two out — offered, but marked for a look
 * Weaving employees are preferred: they are who runs looms.
 */
function matchEmployee(written, employees) {
  const w = foldName(written);
  if (!w) return null;
  const pool = (list) => {
    const weaving = list.filter((e) => e.department === 'weaving');
    return weaving.length ? weaving : list;
  };
  const one = (list, match) => {
    const ids = new Set(list.map((e) => String(e._id)));
    return ids.size === 1 ? { employee: list[0], match } : null;
  };

  const exact = employees.filter((e) => foldName(e.name) === w);
  if (exact.length) return one(pool(exact), 'exact');

  const wt = w.split(' ');
  const byTokens = employees.filter((e) => {
    const et = foldName(e.name).split(' ');
    if (wt.length === 1) return et[0] === wt[0];
    return wt.length <= et.length && wt.every((t, i) => et[i].startsWith(t));
  });
  if (byTokens.length) return one(pool(byTokens), 'close');

  if (w.length >= 4) {
    const allowed = w.length >= 7 ? 2 : 1;
    const scored = employees
      .map((e) => ({ e, d: Math.min(levenshtein(foldName(e.name), w), levenshtein(foldName(e.name).split(' ')[0], w)) }))
      .filter((x) => x.d <= allowed);
    if (scored.length) {
      const best = Math.min(...scored.map((x) => x.d));
      return one(pool(scored.filter((x) => x.d === best).map((x) => x.e)), 'close');
    }
  }
  return null;
}

/** Each row read → the machine it names, its job, and the operator written. */
async function draftPlan(rows) {
  const machines = await Machine.find().select('_id ID orderRunning')
    .populate({ path: 'orderRunning', model: 'JobOrder', select: 'jobOrderNo' }).lean();
  const byAlnum = new Map();
  const byNumber = new Map();
  for (const m of machines) {
    const k = machineKeys(m.ID);
    byAlnum.set(k.alnum, m);
    if (k.number != null) byNumber.set(k.number, [...(byNumber.get(k.number) || []), m]);
  }
  const employees = await Employee.find().select('_id name department').lean();

  const draft = [];
  const seen = new Set();
  for (const r of rows) {
    const notes = [];
    let machine = null;
    if (r.machine) {
      const k = machineKeys(r.machine);
      machine = byAlnum.get(k.alnum)
        || (k.number != null && (byNumber.get(k.number) || []).length === 1 ? byNumber.get(k.number)[0] : null);
    }
    if (!machine) notes.push('No machine with this number');
    else if (seen.has(String(machine._id))) notes.push('Same machine twice on the sheet');
    if (machine) seen.add(String(machine._id));

    const who = r.operator ? matchEmployee(r.operator, employees) : null;
    if (!r.operator) notes.push('No operator written');
    else if (!who) notes.push(`No employee called “${r.operator}”`);
    else if (who.match === 'close') notes.push(`Taken as ${who.employee.name}`);

    draft.push({
      machine: machine?._id ?? null,
      machineID: machine?.ID ?? null,
      machineRead: r.machine,
      jobNo: machine?.orderRunning?.jobOrderNo != null ? `J-${machine.orderRunning.jobOrderNo}` : null,
      operatorRead: r.operator,
      employee: who?.employee._id ?? null,
      employeeName: who?.employee.name ?? null,
      match: who?.match ?? null,
      production: r.production,
      timer: r.timer,
      notes,
    });
  }
  return draft;
}

/** A draft row that can go into the plan as it stands. */
const plannable = (r) => !!(r.machine && r.employee && !r.notes.includes('Same machine twice on the sheet'));

/**
 * Create the shift's plan from a needs_plan slip, then match the slip
 * against it so its figures become the production draft.
 *
 * @param {object} opts
 *   edits  web: [{ index, include, employee }] over planDraft — the rows
 *          to plan and who runs each. Without edits (an "OK" on WhatsApp)
 *          the rows whose operator matched are planned.
 *   expectedVersion  web only: the version the screen was showing
 * @returns {{ slip, created, detailCount }}
 */
async function createPlanFromSlip(slipId, { edits = null, expectedVersion = null } = {}) {
  const slip = await SlipIngest.findById(slipId);
  if (!slip) throw new ErrorHandler('Slip not found', 404);
  if (slip.status !== 'needs_plan') {
    throw new ErrorHandler(`This slip is ${slip.status}; there is no plan to create from it.`, 409);
  }
  if (expectedVersion != null && slip.__v !== expectedVersion) {
    throw new ErrorHandler('The slip changed just now. Reload and try again.', 409);
  }

  const chosen = [];
  if (edits) {
    const valid = (id) => id && /^[a-f\d]{24}$/i.test(String(id));
    for (const e of edits) {
      const row = slip.planDraft[Number(e.index)];
      if (!row || !e.include) continue;
      const employee = e.employee !== undefined ? e.employee : row.employee;
      if (!row.machine) throw new ErrorHandler(`“${row.machineRead || 'A row'}” is not a machine; untick it.`, 400);
      if (!valid(employee)) throw new ErrorHandler(`${row.machineID}: choose the operator.`, 400);
      chosen.push({ machine: row.machine, operator: String(employee), machineID: row.machineID });
    }
  } else {
    for (const row of slip.planDraft) {
      if (plannable(row)) chosen.push({ machine: row.machine, operator: String(row.employee), machineID: row.machineID });
    }
  }
  const byMachine = new Map();
  for (const c of chosen) {
    if (byMachine.has(String(c.machine))) throw new ErrorHandler(`${c.machineID} is ticked twice.`, 400);
    byMachine.set(String(c.machine), c);
  }
  if (!chosen.length) throw new ErrorHandler('No machine has an operator to plan yet.', 400);
  const operators = [...new Set(chosen.map((c) => c.operator))];
  const found = await Employee.countDocuments({ _id: { $in: operators } });
  if (found !== operators.length) throw new ErrorHandler('An operator chosen is not on record.', 400);

  // Someone may have made the plan meanwhile; then the slip is simply
  // matched to that one.
  let created = false;
  let detailCount = 0;
  if (!(await planFor(slip.dateKey, slip.shift))) {
    try {
      const out = await createShiftPlan({
        date: slip.dateKey,
        shiftType: slip.shift,
        description: `From floor sheet${slip.read?.sheetNo ? ` ${slip.read.sheetNo}` : ''} (slip #${slip.confirmCode})`,
        machines: chosen.map((c) => ({ machine: c.machine, operator: c.operator })),
      });
      created = true;
      detailCount = out.detailCount;
    } catch (err) {
      if (err.statusCode !== 409) throw err;
    }
  }

  const staged = await stage(slip, slip.read, { dateKey: slip.dateKey, shift: slip.shift });
  staged.dateFrom = slip.dateFrom; // still known from the sheet, not set by hand
  const saved = await SlipIngest.findOneAndUpdate(
    { _id: slip._id, status: 'needs_plan', __v: slip.__v },
    { $set: staged, $inc: { __v: 1 } },
    { new: true }
  );
  if (!saved) throw new ErrorHandler('The slip changed just now. Reload and try again.', 409);
  return { slip: saved, created, detailCount };
}

// ── Saving ───────────────────────────────────────────────────────

/**
 * Save rows as submitted production.
 *
 * @param {object} opts
 *   user     { _id, name }
 *   edits    web only: [{ index, include, production, timer, remarks }]
 *            — included rows are saved with these values. Without edits
 *            (an "OK" on WhatsApp) only rows marked ready are saved.
 *   expectedVersion  web only: the version the screen was showing
 */
async function applySlip(slipId, { user, edits = null, expectedVersion = null } = {}) {
  // Claimed in one write, so two "OK"s (or OK and the web at once) save once.
  const now = new Date();
  const claim = await SlipIngest.findOneAndUpdate(
    {
      _id: slipId,
      status: 'ready',
      ...(expectedVersion != null ? { __v: expectedVersion } : {}),
      $or: [{ applyingAt: null }, { applyingAt: { $lt: new Date(now.getTime() - APPLY_LEASE_MS) } }],
    },
    { $set: { applyingAt: now } },
    { new: true }
  );
  if (!claim) {
    const cur = await SlipIngest.findById(slipId).select('status __v applyingAt').lean();
    if (!cur) throw new ErrorHandler('Slip not found', 404);
    if (cur.status !== 'ready') throw new ErrorHandler(`This slip is ${cur.status}; there is nothing to save.`, 409);
    throw new ErrorHandler('This slip is being saved or was changed just now. Reload and try again.', 409);
  }

  try {
    const chosen = [];
    if (edits) {
      for (const e of edits) {
        const row = claim.rows[Number(e.index)];
        if (!row || !e.include || row.state === 'skip' || row.applied) continue;
        const production = Number(e.production);
        if (!Number.isInteger(production) || production < 0) {
          throw new ErrorHandler(`${row.machineID || 'A row'}: metres must be a whole number.`, 400);
        }
        const timer = e.timer == null || e.timer === '' ? null : String(e.timer).trim();
        if (timer && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(timer)) {
          throw new ErrorHandler(`${row.machineID || 'A row'}: run time must look like 7:45:00.`, 400);
        }
        chosen.push({ index: Number(e.index), production, timer, remarks: String(e.remarks ?? row.remarks ?? '').slice(0, 300) });
      }
    } else {
      claim.rows.forEach((row, index) => {
        if (row.state === 'ready' && !row.applied && row.production != null) {
          chosen.push({ index, production: row.production, timer: row.timer, remarks: row.remarks });
        }
      });
    }

    let result = { saved: [], skipped: [] };
    if (chosen.length) {
      result = await submitProduction(
        chosen.map((c) => ({
          id: String(claim.rows[c.index].shiftDetail),
          production: c.production,
          ...(c.timer ? { timer: c.timer } : {}),
          feedback: c.remarks,
        })),
        { userId: user?._id, aiSuggestionId: claim.suggestion, surface: SURFACE }
      );
    }

    const savedIds = new Set(result.saved.map((s) => String(s.id)));
    const set = { applyingAt: null };
    for (const c of chosen) {
      if (savedIds.has(String(claim.rows[c.index].shiftDetail))) {
        set[`rows.${c.index}.applied`] = true;
        set[`rows.${c.index}.appliedProduction`] = c.production;
      }
    }
    for (const s of result.skipped) {
      const i = claim.rows.findIndex((r) => String(r.shiftDetail) === String(s.id));
      if (i >= 0) { set[`rows.${i}.state`] = 'skip'; set[`rows.${i}.notes`] = [s.reason]; }
    }
    const remaining = claim.rows.filter((r, i) =>
      r.state !== 'skip' && !r.applied && !set[`rows.${i}.applied`]
      && !result.skipped.some((s) => String(s.id) === String(r.shiftDetail)));
    if (remaining.length === 0) {
      Object.assign(set, { status: 'applied', appliedAt: new Date(), appliedBy: user?._id || null, appliedByName: user?.name || '' });
    }
    const saved = await SlipIngest.findOneAndUpdate(
      { _id: claim._id, applyingAt: now },
      { $set: set, $inc: { __v: 1 } },
      { new: true }
    );
    return { slip: saved, saved: result.saved.length, skipped: result.skipped, remaining: remaining.length };
  } catch (err) {
    await SlipIngest.updateOne({ _id: claim._id, applyingAt: now }, { $set: { applyingAt: null } });
    throw err;
  }
}

async function discardSlip(slipId, { user } = {}) {
  const slip = await SlipIngest.findOneAndUpdate(
    { _id: slipId, status: { $in: SlipIngest.OPEN_STATUSES }, applyingAt: null, 'rows.applied': { $ne: true } },
    { $set: { status: 'discarded', discardedAt: new Date(), discardedByName: user?.name || '' }, $inc: { __v: 1 } },
    { new: true }
  );
  if (!slip) {
    const cur = await SlipIngest.findById(slipId).select('status rows.applied').lean();
    if (!cur) throw new ErrorHandler('Slip not found', 404);
    if ((cur.rows || []).some((r) => r.applied)) {
      throw new ErrorHandler('Some rows from this slip are already saved; it cannot be dropped.', 409);
    }
    throw new ErrorHandler(`This slip is ${cur.status}; it cannot be dropped.`, 409);
  }
  return slip;
}

// ── Talking to the sender ────────────────────────────────────────

function summaryText(slip) {
  const code = slip.confirmCode;
  const link = webLink(slip);
  if (slip.status === 'failed') {
    const lines = [`Slip ${code}: ${slip.problem}`];
    if (slip.read?.rows?.length && (!slip.dateKey || !slip.shift || !slip.shiftPlan)) {
      lines.push(`Reply "${code} DAY 06-10" (or NIGHT) with the right date to try again.`);
    }
    if (link) lines.push(`Or open: ${link}`);
    return lines.join('\n');
  }
  if (slip.status === 'needs_plan') {
    const draft = slip.planDraft || [];
    const ok = draft.filter(plannable);
    const lines = [
      `Slip ${code}: no ${shiftLabel(slip.shift).toLowerCase()} shift plan for ${dateLabel(slip.dateKey)} yet.`,
      `${draft.length} machine${draft.length === 1 ? '' : 's'} written on the sheet; ${ok.length} with an operator matched.`,
    ];
    const doubtful = draft.filter((r) => r.notes.length).slice(0, 6);
    if (doubtful.length) {
      lines.push(`To check: ${doubtful.map((r) => `${r.machineID || r.machineRead} (${r.notes[0]})`).join(', ')}${draft.filter((r) => r.notes.length).length > 6 ? ', …' : ''}`);
    }
    if (ok.length) lines.push(`Reply OK ${code} to create the plan with those ${ok.length}, then confirm the metres.`);
    lines.push(`Reply NO ${code} to drop it.`);
    if (link) lines.push(`Check operators and create the plan: ${link}`);
    return lines.join('\n');
  }
  if (slip.status !== 'ready') return `Slip ${code} is ${slip.status}.`;

  const ready = slip.rows.filter((r) => r.state === 'ready' && !r.applied);
  const check = slip.rows.filter((r) => r.state === 'check' && !r.applied);
  const skip = slip.rows.filter((r) => r.state === 'skip');
  const from = { plan: "the sheet's plan number", sheet: "the sheet number", codes: "the sheet's codes", caption: 'your message', slip: 'the slip', person: 'you' }[slip.dateFrom];
  const lines = [
    `Slip ${code}: ${shiftLabel(slip.shift)} shift, ${dateLabel(slip.dateKey)}${from ? ` (from ${from})` : ''}.`,
    `${slip.rows.length} loom${slip.rows.length === 1 ? '' : 's'} read: ${ready.length} ready, ${check.length} to check.`,
  ];
  const named = (rows) => rows.slice(0, 6).map((r) => `${r.machineID} (${r.notes[0]})`).join(', ') + (rows.length > 6 ? ', …' : '');
  if (check.length) lines.push(`To check: ${named(check)}`);
  if (skip.length) lines.push(`Skipped: ${named(skip)}`);
  if (slip.unmatched?.length) {
    lines.push(`Not in this shift's plan: ${slip.unmatched.slice(0, 6).map((u) => u.machineRead || u.code).join(', ')}`);
  }
  if (ready.length) {
    lines.push(`Reply OK ${code} to save the ${ready.length} ready as submitted (a supervisor still verifies them).`);
  }
  lines.push(`Reply NO ${code} to drop it.`);
  if (link) lines.push(`Check or correct: ${link}`);
  return lines.join('\n');
}

async function tellSender(slip) {
  if (slip.source !== 'whatsapp' || !slip.from) return;
  await sendWhatsApp(slip.from, summaryText(slip));
}

/** The open slip a WhatsApp reply refers to: the sender's own first. */
async function slipByCode(code, from) {
  const open = await SlipIngest.find({ confirmCode: code, status: { $in: SlipIngest.OPEN_STATUSES } })
    .sort({ createdAt: -1 }).limit(5);
  return open.find((s) => s.from === from) || open[0] || null;
}

module.exports = {
  receiveFromWhatsApp,
  receiveUpload,
  readSlipJob,
  setShift,
  createPlanFromSlip,
  applySlip,
  discardSlip,
  summaryText,
  slipByCode,
  slipSender,
  parseSlipCommand,
  parseDateShift,
  SURFACE,
  _internals: { machineKeys, normCode, resolveShift, matchRows, planFor, stage, downloadMedia, matchEmployee, draftPlan },
};
