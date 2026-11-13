'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY PHOTO SENT TO THE WHATSAPP NUMBER, SORTED
//
//  Until now every photo went to the production slip reader, so a bill
//  or a receipt sent on WhatsApp was read as a slip. Now each is sorted
//  first and handed to the reader that exists for it:
//
//    production slip   → the slip reader (services/slipIngest.js), which
//                        replies with what it read, as before
//    supplier's bill,  → the bills inbox (services/billMailbox.js fileOne),
//    expense receipt     beside the mailed bills: read, matched, "ready"
//    cheque            → read (services/chequeIntake.js) and kept here,
//                        ready to enter as a receipt or a post-dated cheque
//    delivery challan  → read (utils/inwardOcr.js), matched to its PO, kept
//                        here to receive
//    purchase order,   → the customer inbox (services/customerInbox.js),
//    payment advice      beside customer mail
//    anything else     → kept here for a person to say what it is
//
//  What decides the kind, in order: the caption ("bill", "cheque",
//  "DAY 06-10"), an e-invoice QR (a supplier's bill, for certain), the
//  model (surface whatsapp-sort), else the old default (a slip, from a
//  production login; otherwise "something else"). A customer's photo can
//  only be an order, an advice, a cheque or other; a supplier's a bill,
//  a challan or other.
//
//  Nothing is posted from here. A wrong sort is put right by a reply
//  ("BILL 4821") or on the web; whatever the first sort made is set aside
//  first, and refused when someone has already acted on it.
//
//  receive()      the webhook's part: kept, queued, answered at once
//  sortJob()      the queue's part (outbox kind paper.sort)
//  reroute()      a person says what it is
//  markEntered()  a receipt or goods receipt was entered from it
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const WhatsAppPaper = require('../models/WhatsAppPaper');
const ErrorHandler = require('../utils/ErrorHandler');
const { enqueue } = require('../utils/outbox');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const { noted } = require('../utils/noted');

const { KINDS } = WhatsAppPaper;
const SURFACE = 'whatsapp-sort';
const MAX_ATTEMPTS = 3;
const MAX_FILES = 4;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const READABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
/** Photos one phone may send in a day: past that, a loop or a forward-all is not read. */
const PER_DAY = { staff: 80, customer: 15, supplier: 15 };
/** What each kind of sender's photo can be. */
const ALLOWED = {
  staff: KINDS,
  customer: ['purchase_order', 'payment_advice', 'cheque', 'other'],
  supplier: ['supplier_bill', 'delivery_challan', 'other'],
};
const WORDS = {
  production_slip: 'a production slip', supplier_bill: 'a supplier\'s bill', expense_receipt: 'a receipt', cheque: 'a cheque',
  delivery_challan: 'a delivery challan', purchase_order: 'a purchase order', payment_advice: 'a payment advice', other: 'something else',
};
/** The word a reply starts with to send a photo on: "BILL 4821". */
const COMMAND_WORDS = {
  slip: 'production_slip', sheet: 'production_slip',
  bill: 'supplier_bill', invoice: 'supplier_bill',
  receipt: 'expense_receipt', expense: 'expense_receipt',
  cheque: 'cheque', chq: 'cheque',
  dc: 'delivery_challan', challan: 'delivery_challan',
  po: 'purchase_order', order: 'purchase_order',
  paid: 'payment_advice', advice: 'payment_advice', payment: 'payment_advice',
  ignore: 'dismiss',
};

const lower = (s) => String(s || '').toLowerCase();
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const extOf = (t) => ({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[t] || 'jpg');
const allowedFor = (paper) => (paper.who === 'staff' && !paper.mayRecordSlips
  ? KINDS.filter((k) => k !== 'production_slip')
  : ALLOWED[paper.who] || ['other']);
const sendOnHint = (code) => `\nReply with what it is: BILL ${code}, RECEIPT ${code}, CHEQUE ${code}, SLIP ${code}, DC ${code}, PO ${code} or PAID ${code}. IGNORE ${code} if it is not for us.`;

// ── Who sent it ──────────────────────────────────────────────────

/**
 * The sender, if their photos are read: one of our people (a login with
 * production or accounts access whose employee record has this phone, or
 * a number on the owner's list), else a customer or a supplier on file.
 * → { who: 'staff', userId, name, slips } | { who: 'customer', customer } |
 *   { who: 'supplier', supplier } | null
 */
async function whoSent(e164) {
  const { normalisePhone } = require('../utils/workerLogin');
  const { isSelfServiceOnly } = require('../utils/features');
  const phone = normalisePhone(e164);
  if (phone) {
    const Employee = require('../models/Employee');
    const User = require('../models/User');
    const employees = await Employee.find({ phoneNumber: { $in: [phone, `+91${phone}`, `0${phone}`, `91${phone}`] } }).select('_id').limit(5).lean();
    if (employees.length) {
      const users = await User.find({ employee: { $in: employees.map((e) => e._id) } }).select('_id name role employee features').lean();
      const ours = users.filter((u) => ['admin', 'production', 'accounts'].includes(u.role) && !isSelfServiceOnly(u));
      const user = ours.find((u) => u.role !== 'accounts') || ours[0];
      if (user) return { who: 'staff', userId: user._id, name: user.name, slips: ['admin', 'production'].includes(user.role) };
    }
  }
  const NotificationSettings = require('../models/NotificationSettings');
  const settings = await NotificationSettings.load();
  if ((settings.recipients || []).includes(String(e164).trim())) {
    const s = await require('./slipIngest').slipSender(e164);
    return { who: 'staff', userId: s?.userId || null, name: s?.name || `Owner (${e164})`, slips: true };
  }
  const customer = await require('./collectionReply').customerForPhone(e164);
  if (customer) return { who: 'customer', customer: { _id: customer._id, name: customer.name } };
  const supplier = await require('./poChaser').supplierForPhone(e164);
  if (supplier) return { who: 'supplier', supplier: { _id: supplier._id, name: supplier.name } };
  return null;
}

// ── What the caption says ────────────────────────────────────────

/** A caption that names a shift ("DAY 06-10", "night") or says slip: the slip reader, as it always was. */
function isSlipCaption(caption) {
  const t = String(caption || '').trim();
  if (!t) return false;
  if (/\b(slip|sheet)\b/i.test(t)) return true;
  const { dateKey, shift } = require('./slipIngest').parseDateShift(t);
  if (dateKey && shift) return true;
  return /^(day|night)\b/i.test(t) && t.length <= 30;
}

/** The kind a caption names, or null. */
function captionKind(caption) {
  const t = lower(caption);
  if (!t.trim()) return null;
  if (isSlipCaption(caption)) return 'production_slip';
  if (/\b(cheque|chq|cheq|pdc)\b/.test(t)) return 'cheque';
  if (/\b(dc|d\.c|challan|delivery note|cone labels?|bag labels?)\b/.test(t)) return 'delivery_challan';
  if (/\b(receipt|petty|expense|fuel|petrol|diesel|courier|auto|taxi)\b/.test(t)) return 'expense_receipt';
  if (/\b(bill|invoice)\b/.test(t)) return 'supplier_bill';
  if (/\b(purchase order|p\.o|po)\b/.test(t)) return 'purchase_order';
  if (/\b(payment|paid|utr|neft|rtgs|imps|remittance|advice)\b/.test(t)) return 'payment_advice';
  return null;
}

/** "BILL 4821", "ignore 4821" → { kind, code }; anything else null. */
function parseCommand(text) {
  const m = String(text || '').trim().match(/^([a-z]+)\s+(\d{4})$/i);
  if (!m) return null;
  const kind = COMMAND_WORDS[m[1].toLowerCase()];
  return kind ? { kind, code: m[2] } : null;
}

// ── Taking it in ─────────────────────────────────────────────────

async function newCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!(await WhatsAppPaper.exists({ code, status: { $in: ['received', 'sorting', 'waiting'] } }))) return code;
  }
  return String(crypto.randomInt(1000, 10000));
}

/**
 * The webhook's part: kept and queued, so Twilio is answered at once.
 * Idempotent on Twilio's message id. → { paper, duplicate } |
 * { capped: true } | { unsupported: true }
 */
async function receive({ messageSid, from, caption, media, sender }) {
  if (messageSid) {
    const existing = await WhatsAppPaper.findOne({ messageSid }).lean();
    if (existing) return { paper: existing, duplicate: true };
  }
  const usable = (media || []).filter((m) => m && m.url && READABLE.has(String(m.contentType || '').toLowerCase().split(';')[0].trim())).slice(0, MAX_FILES);
  if (!usable.length) return { unsupported: true };
  const sent = await WhatsAppPaper.countDocuments({ from, createdAt: { $gte: new Date(Date.now() - 86_400_000) } });
  if (sent >= (PER_DAY[sender.who] || 15)) return { capped: true };
  const party = sender.customer || sender.supplier || null;
  try {
    const paper = await WhatsAppPaper.create({
      messageSid: messageSid || undefined,
      from,
      who: sender.who,
      sentBy: sender.userId || null,
      sentByName: sender.name || party?.name || '',
      mayRecordSlips: sender.who === 'staff' && !!sender.slips,
      customer: sender.customer?._id || null,
      supplier: sender.supplier?._id || null,
      partyName: party?.name || '',
      caption: String(caption || '').slice(0, 500),
      media: usable.map((m) => ({ url: m.url, contentType: String(m.contentType || '').toLowerCase().split(';')[0].trim() })),
      pages: usable.length,
      code: await newCode(),
    });
    await enqueue(null, 'paper.sort', { paperId: String(paper._id) });
    return { paper: paper.toObject(), duplicate: false };
  } catch (err) {
    if (err?.code === 11000 && messageSid) return { paper: await WhatsAppPaper.findOne({ messageSid }).lean(), duplicate: true };
    throw err;
  }
}

const filesToPages = (files) => (files || []).map((f) => ({ buffer: Buffer.from(f.data || '', 'base64'), mimetype: f.contentType })).filter((p) => p.buffer.length);

// ── Sorting ──────────────────────────────────────────────────────

const SORT_PROMPT = [
  'A photo (or PDF) sent to the WhatsApp number of an elastic (narrow fabric) factory in Tamil Nadu, India. Say what paper it is. Return ONLY JSON:',
  '{"kind":"supplier_bill","summary":"Sri Yarn Traders tax invoice SY/118, ₹19,530"}',
  'kind, one of:',
  '- production_slip: the factory\'s own shift or production sheet: machine or loom numbers with metres, timers, operator names (often handwritten, or a printed floor sheet).',
  '- supplier_bill: a supplier\'s tax invoice or bill to the factory (GSTIN, HSN, taxable value, GST).',
  '- expense_receipt: a shop bill, cash memo, fuel bill, courier, auto or travel receipt; a small expense, usually without the factory\'s GSTIN.',
  '- cheque: a bank cheque.',
  '- delivery_challan: a supplier\'s delivery challan, or the labels on cones or bags of goods delivered (quantities, lots; no tax).',
  '- purchase_order: a customer\'s purchase order to the factory.',
  '- payment_advice: a payment confirmation, a NEFT / RTGS / UPI screenshot or a remittance advice.',
  '- other: anything else.',
  'summary: at most 100 characters, in English.',
].join('\n');

/** The kind, and what decided it. Never throws: the old default stands when nothing else can say. */
async function sortKind(paper, pages) {
  const allowed = allowedFor(paper);
  const fallback = { kind: allowed.includes('production_slip') ? 'production_slip' : 'other', kindBy: 'fallback', summary: '', aiSuggestion: '' };
  const fromCaption = captionKind(paper.caption);
  if (fromCaption && allowed.includes(fromCaption)) return { kind: fromCaption, kindBy: 'caption', summary: '', aiSuggestion: '' };
  // A signed e-invoice QR is a supplier's bill, whatever else is on the page.
  if (allowed.includes('supplier_bill')) {
    const found = await require('./billQr').findEinvoice(pages).catch(() => null);
    if (found?.qr) return { kind: 'supplier_bill', kindBy: 'qr', summary: '', aiSuggestion: '' };
  }
  const { anthropic } = require('../utils/anthropicClient');
  if (!anthropic()) return fallback;
  const startedAt = Date.now();
  try {
    const r = await require('../utils/docRead').readJson({ pages: pages.slice(0, 1), prompt: SORT_PROMPT, maxTokens: 300, maxPages: 1 });
    const kind = KINDS.includes(r.data?.kind) ? r.data.kind : null;
    if (!kind) throw new Error('the reply named no kind');
    const id = await aiLedger.record({
      surface: SURFACE, model: r.model, promptVersion: promptVersion(SURFACE), refType: 'WhatsAppPaper', refId: paper._id,
      proposed: { kind }, latencyMs: r.latencyMs, usage: r.usage,
    }).catch(() => null);
    return { kind: allowed.includes(kind) ? kind : 'other', kindBy: 'model', summary: String(r.data.summary || '').slice(0, 120), aiSuggestion: id ? String(id) : '' };
  } catch (err) {
    await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), refType: 'WhatsAppPaper', refId: paper._id, latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
    return fallback;
  }
}

// ── Handing it on ────────────────────────────────────────────────

/**
 * Hand the photo to the reader for `kind`. → { status, kind?, sentTo?,
 * result?, note?, reply } — reply is what the sender is told (staff
 * only; customers and suppliers were thanked when it came).
 */
async function routeTo(paper, kind, pages) {
  const staff = paper.who === 'staff';
  const code = paper.code;
  const hint = staff ? sendOnHint(code) : '';

  if (kind === 'production_slip') {
    const { slip } = await require('./slipIngest').receivePages({ from: paper.from, caption: paper.caption, pages, sender: { userId: paper.sentBy, name: paper.sentByName } });
    // The slip reader tells the sender what it read, with its own number.
    return { status: 'done', sentTo: { doc: 'SlipIngest', docId: slip._id, label: `Production slip ${slip.confirmCode}` }, reply: null };
  }

  if (kind === 'supplier_bill' || kind === 'expense_receipt') {
    const InboxBill = require('../models/InboxBill');
    // A sort that stopped half way is not filed twice.
    let ib = await InboxBill.findOne({ paper: paper._id, status: 'new' }).lean();
    if (!ib) {
      const messageId = `wa:${paper._id}`;
      const p = pages[0];
      const doc = {
        messageId, part: (await InboxBill.countDocuments({ messageId })) + 1, source: 'whatsapp', paper: paper._id,
        from: paper.from, sentByName: paper.sentByName || paper.partyName, subject: paper.caption || 'WhatsApp photo', receivedAt: paper.createdAt || new Date(),
        filename: `whatsapp-${code}.${extOf(p.mimetype)}`, contentType: p.mimetype, size: p.buffer.length,
      };
      const out = await require('./billMailbox').fileOne(doc, p.buffer, p.mimetype, { senderSupplier: paper.supplier });
      ib = out.inboxBill?.toObject ? out.inboxBill.toObject() : out.inboxBill;
      if (out.status !== 'new' || !ib) {
        const note = ib?.note || 'The bill could not be read';
        return { status: 'waiting', kind: 'other', note, reply: staff ? `${note === 'Not a bill' ? 'That does not look like a bill' : note} (${code}).${hint}` : null };
      }
    }
    const read = ib.read || {};
    const isReceipt = read.kind === 'receipt' || kind === 'expense_receipt';
    const what = `${isReceipt ? 'Receipt' : 'Bill'} from ${ib.supplierName || read.supplierName || 'a supplier not on file'}${read.billNo ? ` #${read.billNo}` : ''}${ib.grand != null ? `, ${rupees(ib.grand)}` : ''}`;
    let state;
    if (ib.alreadyEntered) state = `already entered as ${ib.alreadyEntered}`;
    else if (isReceipt) state = 'to enter as an expense';
    else {
      const ready = (await require('./billReady').readinessAll([ib]).catch(() => [null]))[0];
      state = ready?.ready ? 'ready to enter' : `needs a look: ${(ready?.why || [])[0] || 'check it against the photo'}`;
    }
    return { status: 'done', kind: isReceipt ? 'expense_receipt' : 'supplier_bill', sentTo: { doc: 'InboxBill', docId: ib._id, label: what }, reply: staff ? `${what} is in Accounts → Bills by mail, ${state}.` : null };
  }

  if (kind === 'cheque') {
    let r;
    try {
      r = await require('./chequeIntake').fromPhoto({ pages, customer: paper.customer, refType: 'WhatsAppPaper', refId: paper._id });
    } catch (err) {
      const note = err.code === 'ANTHROPIC_KEY_MISSING' ? 'Reading cheques is not set up on this server: enter it by hand' : `The cheque could not be read: ${err.message}`.slice(0, 300);
      return { status: 'waiting', kind: 'cheque', note, reply: staff ? `${note} (${code}).` : null };
    }
    if (r.read.problem) {
      const note = r.read.problem === 'not_a_cheque' ? 'Not a cheque' : 'The cheque could not be read';
      return { status: 'waiting', kind: 'other', note, reply: staff ? `${note === 'Not a cheque' ? 'That does not look like a cheque' : note} (${code}).${hint}` : null };
    }
    const d = r.draft;
    const from = r.customer?.name || r.read.drawer;
    const what = `Cheque ${d.cheque.number || '(number not read)'}${from ? ` from ${from}` : ''}${d.amount != null ? ` for ${rupees(d.amount)}` : ''}${r.read.date ? `, dated ${r.read.date.split('-').reverse().join('/')}` : ''}`;
    const dangers = r.checks.filter((c) => c.severity === 'danger').map((c) => `⚠ ${c.message}`);
    if (r.duplicate) {
      return { status: 'done', sentTo: { doc: 'Payment', docId: r.duplicate._id, label: r.duplicate.voucherNo }, result: r, note: `Already entered as ${r.duplicate.voucherNo}`, reply: staff ? `${what}: already entered as ${r.duplicate.voucherNo}.` : null };
    }
    const state = d.postDated ? 'a post-dated cheque, ready to enter (held until its date)' : 'ready to enter as a receipt';
    return { status: 'waiting', result: r, note: r.customer ? '' : 'Who paid is not clear: pick the customer', reply: staff ? [`${what}: ${state} in Accounts → Inbox.`, ...dangers].join('\n') : null };
  }

  if (kind === 'delivery_challan') {
    let read;
    const startedAt = Date.now();
    try {
      read = await require('../utils/inwardOcr').readInward(pages);
    } catch (err) {
      const note = err.code === 'ANTHROPIC_KEY_MISSING' ? 'Reading challans is not set up on this server: receive it by hand' : `The challan could not be read: ${err.message}`.slice(0, 300);
      if (!err.code) await aiLedger.record({ surface: 'inward-dc-ocr', model: '?', promptVersion: promptVersion('inward-dc-ocr'), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
      return { status: 'waiting', kind: 'delivery_challan', note, reply: staff ? `${note} (${code}).` : null };
    }
    if (read.problem) {
      return { status: 'waiting', kind: 'other', note: 'Not a challan', reply: staff ? `That does not look like a challan (${code}).${hint}` : null };
    }
    const { model, usage, latencyMs, ...fields } = read;
    const { po, rows } = await require('./inwardMatch').matchInward(fields, {});
    const aiSuggestion = await aiLedger.record({
      surface: 'inward-dc-ocr', model, promptVersion: promptVersion('inward-dc-ocr'), refType: 'PurchaseOrder', refId: po?._id,
      proposed: { dcNo: fields.dcNo, poNumber: fields.poNumber, lines: rows.map((x) => ({ material: x.materialName, quantity: x.quantity, lotNo: x.lotNo, shade: x.shade })) },
      latencyMs, usage,
    }).catch(() => null);
    const what = `Challan${fields.supplierName ? ` from ${fields.supplierName}` : ''}${fields.dcNo ? ` (DC ${fields.dcNo})` : ''}${po ? ` for PO #${po.poNo}` : ''}: ${rows.length} line${rows.length === 1 ? '' : 's'} read`;
    return {
      status: 'waiting', result: { read: fields, po, rows, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null },
      note: po ? '' : 'Its purchase order was not found: pick one',
      reply: staff ? `${what}. ${po ? 'Receive it from Accounts → Inbox.' : 'Its PO was not found: open it in Accounts → Inbox to pick one.'}` : null,
    };
  }

  if (kind === 'purchase_order' || kind === 'payment_advice') {
    const InboxMail = require('../models/InboxMail');
    let im = await InboxMail.findOne({ paper: paper._id, status: { $in: ['reading', 'new', 'done'] } }).select('-text -draft').lean();
    let note = im?.note || '';
    if (!im) {
      const n = (await InboxMail.countDocuments({ paper: paper._id })) + 1;
      const customer = paper.customer ? { _id: paper.customer, name: paper.partyName } : null;
      const out = await require('./customerInbox').fileWhatsApp({ messageId: `wa:${paper._id}:${n}`, from: paper.from, caption: paper.caption, kind, pages, customer, paper: paper._id, notifyOffice: paper.who === 'customer' });
      im = out.inboxMail;
      note = out.note;
    }
    const label = `${kind === 'purchase_order' ? 'Purchase order' : 'Payment advice'}${note ? `: ${note}` : ''}`;
    return { status: 'done', sentTo: { doc: 'InboxMail', docId: im?._id || null, label: label.slice(0, 200) }, reply: staff ? `${label || WORDS[kind]} (Accounts → Inbox, customer mail).` : null };
  }

  return { status: 'waiting', kind: 'other', reply: staff ? `I could not tell what this is (${code}).${hint}` : null };
}

async function tell(paper, text) {
  if (!text || paper.who !== 'staff' || !paper.from) return;
  const { sendWhatsApp } = require('../utils/whatsapp');
  await sendWhatsApp(paper.from, text).catch(noted(`telling ${paper.from} where photo ${paper.code} went`));
}

/** Fetch the photo once and keep it here: the links Twilio gives do not last. */
async function fetchPages(paper) {
  if (paper.files?.length) return filesToPages(paper.files);
  const pages = (await require('./slipIngest').downloadMedia(paper.media || []))
    .filter((p) => READABLE.has(String(p.mimetype || '').split(';')[0]))
    .slice(0, MAX_FILES);
  let total = 0;
  const kept = pages.filter((p) => { total += p.buffer.length; return total <= MAX_TOTAL_BYTES; });
  if (!kept.length) throw Object.assign(new Error('Nothing in it is a photo or a PDF'), { permanent: true });
  await WhatsAppPaper.updateOne({ _id: paper._id }, { $set: {
    files: kept.map((p) => ({ contentType: p.mimetype, size: p.buffer.length, data: p.buffer.toString('base64') })),
    media: [], pages: kept.length,
  } });
  return kept;
}

/**
 * The queue's part (outbox kind paper.sort): fetch, sort, hand on, tell
 * the sender. A failure retrying can fix is thrown for the outbox to retry.
 */
async function sortJob(paperId) {
  const paper = await WhatsAppPaper.findOneAndUpdate(
    { _id: paperId, status: { $in: ['received', 'sorting'] } },
    { $set: { status: 'sorting' }, $inc: { attempts: 1 } },
    { new: true }
  ).select('+media +files').lean();
  if (!paper) return { skipped: 'not waiting to be sorted' };
  try {
    const pages = await fetchPages(paper);
    const sorted = await sortKind(paper, pages);
    const out = await routeTo(paper, sorted.kind, pages);
    const saved = await WhatsAppPaper.findOneAndUpdate(
      { _id: paper._id, status: 'sorting' },
      { $set: {
        kind: out.kind || sorted.kind, kindBy: sorted.kindBy, summary: sorted.summary, aiSuggestion: sorted.aiSuggestion,
        status: out.status, sentTo: out.sentTo || null, result: out.result ?? null, note: out.note || '',
      } },
      { new: true }
    ).lean();
    if (saved) await tell(saved, out.reply);
    return { kind: saved?.kind || null, status: saved?.status || null };
  } catch (err) {
    const permanent = err.permanent || err?.response?.status === 404 || ['UNSUPPORTED_TYPE', 'NO_PAGES'].includes(err.code);
    if (!permanent && paper.attempts < MAX_ATTEMPTS) {
      await WhatsAppPaper.updateOne({ _id: paper._id, status: 'sorting' }, { $set: { status: 'received' } });
      throw err;
    }
    const note = err.permanent ? err.message : 'The photo could not be fetched or read. Please send it again.';
    const failed = await WhatsAppPaper.findOneAndUpdate({ _id: paper._id, status: 'sorting' }, { $set: { status: 'failed', note: String(note).slice(0, 300) } }, { new: true }).lean();
    if (failed) await tell(failed, `${note} (${failed.code})`);
    return { failed: note };
  }
}

// ── A person says what it is ─────────────────────────────────────

/** Set aside whatever the earlier sort made, refusing when someone has acted on it. */
async function undo(paper, user) {
  const to = paper.sentTo;
  if (!to?.doc || !to.docId) return;
  const decided = { decidedBy: user?._id || null, decidedAt: new Date() };
  if (to.doc === 'SlipIngest') {
    const SlipIngest = require('../models/SlipIngest');
    const slip = await SlipIngest.findById(to.docId).select('status').lean();
    if (!slip || slip.status === 'discarded') return;
    if (!SlipIngest.OPEN_STATUSES.includes(slip.status)) throw new ErrorHandler('Its production slip is saved already: change it under Production slips', 409);
    await require('./slipIngest').discardSlip(slip._id, { user });
  } else if (to.doc === 'InboxBill') {
    const InboxBill = require('../models/InboxBill');
    const r = await InboxBill.updateOne({ _id: to.docId, status: { $in: ['new', 'failed', 'skipped'] } }, { $set: { status: 'dismissed', note: 'Sent elsewhere from WhatsApp', ...decided } });
    if (!r.matchedCount) {
      const ib = await InboxBill.findById(to.docId).select('status').lean();
      if (ib?.status === 'entered') throw new ErrorHandler('It is entered as a bill already: change it there', 409);
    }
  } else if (to.doc === 'InboxMail') {
    const InboxMail = require('../models/InboxMail');
    const im = await InboxMail.findById(to.docId).select('orderRequest complaint status').lean();
    if (im?.orderRequest) throw new ErrorHandler('It became an order request: change it under Orders', 409);
    if (im?.complaint) throw new ErrorHandler('It became a complaint: change it there', 409);
    if (im) await InboxMail.updateOne({ _id: im._id }, { $set: { status: 'dismissed', note: 'Sent elsewhere from WhatsApp', ...decided } });
  }
  // A cheque found already entered pointed at that receipt: nothing of ours to set aside.
}

/**
 * Send a photo on as `kind`. → { paper, reply }
 * Throws an ErrorHandler for what the person can put right.
 */
async function reroute(id, kind, { user = null } = {}) {
  if (!KINDS.includes(kind)) throw new ErrorHandler('Say what the photo is', 400);
  const current = await WhatsAppPaper.findById(id).select('+files').lean();
  if (!current) throw new ErrorHandler('Not found', 404);
  if (['received', 'sorting'].includes(current.status)) throw new ErrorHandler('It is still being sorted: try again in a minute', 409);
  if (current.status === 'dismissed') throw new ErrorHandler('It was set aside', 409);
  if (current.entered?.docId) throw new ErrorHandler(`It is entered already, as ${current.entered.label}`, 409);
  if (!allowedFor(current).includes(kind)) throw new ErrorHandler(`A photo from this sender cannot be ${WORDS[kind]}`, 400);
  const pages = filesToPages(current.files);
  if (!pages.length) throw new ErrorHandler('The photo is no longer kept: ask for it to be sent again', 409);
  // Claimed, so two people sending it on at once do not both file it.
  const claimed = await WhatsAppPaper.findOneAndUpdate({ _id: id, status: current.status, updatedAt: current.updatedAt }, { $set: { status: 'sorting' } }, { new: true }).lean();
  if (!claimed) throw new ErrorHandler('It changed meanwhile: reload and try again', 409);
  try {
    await undo(current, user);
  } catch (err) {
    await WhatsAppPaper.updateOne({ _id: id, status: 'sorting' }, { $set: { status: current.status } });
    throw err;
  }
  let out;
  try {
    out = await routeTo(current, kind, pages);
  } catch (err) {
    await WhatsAppPaper.updateOne({ _id: id, status: 'sorting' }, { $set: { status: 'waiting', kind, sentTo: null, note: `Could not be sent on: ${err.message}`.slice(0, 300) } });
    throw err;
  }
  // A person said what it is: that scores the sort, right or wrong.
  if (current.aiSuggestion) aiLedger.settle(current.aiSuggestion, { accepted: { kind }, decidedBy: user?._id }).catch(noted(`scoring the sort of photo ${current.code}`));
  const paper = await WhatsAppPaper.findOneAndUpdate({ _id: id, status: 'sorting' }, { $set: {
    kind: out.kind || kind, kindBy: 'person', status: out.status, sentTo: out.sentTo || null, result: out.result ?? null, note: out.note || '',
    decidedBy: user?._id || null, decidedAt: new Date(),
  } }, { new: true }).lean();
  return { paper, reply: out.reply };
}

/** Not for the books. */
async function dismiss(id, { user = null, reason = '' } = {}) {
  const paper = await WhatsAppPaper.findOneAndUpdate(
    { _id: id, status: { $in: ['waiting', 'failed'] } },
    { $set: { status: 'dismissed', note: String(reason || 'Set aside').slice(0, 200), decidedBy: user?._id || null, decidedAt: new Date() } },
    { new: true }
  ).lean();
  if (!paper) throw new ErrorHandler('Not found, or not waiting on anyone', 404);
  return paper;
}

/**
 * A receipt (from a cheque) or a goods receipt (from a challan) was
 * entered from this photo: done, and the sort scored as right.
 */
async function markEntered(id, place, { user = null } = {}) {
  const mongoose = require('mongoose');
  if (!mongoose.isValidObjectId(String(id || ''))) return null;
  const paper = await WhatsAppPaper.findOneAndUpdate(
    { _id: id, status: 'waiting', entered: null },
    { $set: { status: 'done', entered: place, decidedBy: user?._id || null, decidedAt: new Date() } },
    { new: true }
  ).lean();
  if (paper?.aiSuggestion) aiLedger.settle(paper.aiSuggestion, { accepted: { kind: paper.kind }, decidedBy: user?._id }).catch(noted(`scoring the sort of photo ${paper.code}`));
  return paper;
}

/**
 * A reply that sends a photo on ("BILL 4821", "IGNORE 4821"), from one
 * of our people. → { reply } — or null when the sender is not staff, so
 * the message goes on as an ordinary one.
 */
async function handleCommand(e164, cmd) {
  const sender = await whoSent(e164);
  if (!sender || sender.who !== 'staff') return null;
  const paper = await WhatsAppPaper.findOne({ code: cmd.code, from: e164, status: { $in: ['waiting', 'done', 'failed'] }, createdAt: { $gte: new Date(Date.now() - 7 * 86_400_000) } })
    .sort({ createdAt: -1 }).select('_id code').lean();
  if (!paper) return { reply: `There is no photo numbered ${cmd.code} from this phone this week.` };
  const user = { _id: sender.userId, name: sender.name };
  try {
    if (cmd.kind === 'dismiss') {
      await dismiss(paper._id, { user, reason: 'Not for us (said on WhatsApp)' });
      return { reply: `Photo ${cmd.code} set aside. Nothing was entered from it.` };
    }
    const out = await reroute(paper._id, cmd.kind, { user });
    return { reply: out.reply || `Photo ${cmd.code} sent on as ${WORDS[cmd.kind]}.` };
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) return { reply: err.message };
    throw err;
  }
}

module.exports = {
  whoSent, isSlipCaption, captionKind, parseCommand, receive, sortJob, sortKind, routeTo, reroute, dismiss, markEntered, handleCommand,
  allowedFor, filesToPages, KINDS, WORDS, SURFACE, SORT_PROMPT,
};
