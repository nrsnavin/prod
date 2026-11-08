'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BILLS MAILBOX — supplier bills that arrive by mail, as drafts
//
//  Suppliers mail their tax invoices; forward them to a mailbox of their
//  own (bills@…) and this reads it every few minutes: each PDF or photo
//  attached is read like a scanned bill (utils/billOcr.js), matched to a
//  supplier on file (services/billMatch.js), and waits in the accounts
//  inbox to be opened as a filled-in bill, checked and entered — or
//  dismissed. Nothing reaches the books without a person.
//
//  Set BILLS_IMAP_HOST, BILLS_IMAP_USER, BILLS_IMAP_PASS (and _PORT,
//  _SECURE, BILLS_MAILBOX, BILLS_EVERY_MIN). BILLS_FROM, when set, is the
//  only senders read (addresses or @domains); otherwise anyone's mail is
//  read, so the reading is capped: BILLS_MAX_PER_RUN mails a run, four
//  files a mail, 10 MB a file. A mail is claimed before it is read, so
//  two processes never read it twice.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const InboxBill = require('../models/InboxBill');
const { readBill, SUPPORTED } = require('../utils/billOcr');
const { matchRead } = require('./billMatch');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const MAX_FILES = 4;
const MAX_BYTES = 10 * 1024 * 1024;

function config() {
  const e = process.env;
  return {
    host: e.BILLS_IMAP_HOST || '', port: Number(e.BILLS_IMAP_PORT || 993), secure: e.BILLS_IMAP_SECURE !== 'false',
    user: e.BILLS_IMAP_USER || '', pass: e.BILLS_IMAP_PASS || '', mailbox: e.BILLS_MAILBOX || 'INBOX',
    senders: String(e.BILLS_FROM || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    everyMin: e.BILLS_EVERY_MIN === undefined ? 10 : Number(e.BILLS_EVERY_MIN),
    maxPerRun: Number(e.BILLS_MAX_PER_RUN || 20),
    days: 7,
  };
}
const configured = (c = config()) => !!(c.host && c.user && c.pass);

/** An address on the list, or at a @domain on it. Empty list: anyone. */
function senderOk(from, list) {
  if (!list.length) return true;
  const f = String(from || '').toLowerCase();
  return list.some((s) => (s.startsWith('@') ? f.endsWith(s) : f === s));
}

async function imapFetch(c, { since, isKnown }) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  const out = [];
  try {
    const lock = await client.getMailboxLock(c.mailbox);
    try {
      const uids = await client.search({ since }, { uid: true });
      const fresh = [];
      for await (const m of client.fetch(uids.slice(-200), { envelope: true }, { uid: true })) {
        const id = m.envelope?.messageId || `uid-${m.uid}`;
        if (!(await isKnown(id))) fresh.push(m.uid);
      }
      for (const uid of fresh.slice(0, c.maxPerRun)) {
        const m = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (m?.source) out.push({ messageId: m.envelope?.messageId || `uid-${uid}`, source: m.source });
      }
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}
let fetcher = imapFetch;
/** Tests replace the mailbox with a list of raw messages. */
function setFetcher(fn) { fetcher = fn || imapFetch; }

const typeOf = (a) => {
  const t = String(a.contentType || '').toLowerCase().split(';')[0];
  if (SUPPORTED.has(t)) return t;
  const ext = String(a.filename || '').toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || null;
};

/** One mail: each bill file in it read, matched and kept as a draft. */
async function handle(raw, c = config()) {
  const { simpleParser } = require('mailparser');
  const mail = await simpleParser(raw.source);
  const messageId = mail.messageId || raw.messageId || `sha-${crypto.createHash('sha256').update(raw.source).digest('hex').slice(0, 32)}`;
  const from = String(mail.from?.value?.[0]?.address || '').toLowerCase();
  const base = { messageId, from, subject: String(mail.subject || '').slice(0, 300), receivedAt: mail.date || new Date() };

  // Claimed first (part 0 holds the mail): a second process sees the duplicate and leaves it.
  try { await InboxBill.create({ ...base, part: 0, status: 'skipped', note: 'reading' }); } catch (err) {
    if (err?.code === 11000) return { status: 'known', bills: 0 };
    throw err;
  }
  const settle = (status, note) => InboxBill.updateOne({ messageId, part: 0 }, { $set: { status, note } });

  if (!senderOk(from, c.senders)) { await settle('skipped', `${from || 'Unknown sender'} is not on the bills senders list`); return { status: 'skipped', bills: 0 }; }
  // Any PDF or photo — but not the small pictures inside a mail's
  // signature (a logo, a social icon), which are inline and tiny.
  const files = (mail.attachments || [])
    .map((a) => ({ a, type: typeOf(a) }))
    .filter(({ a, type }) => type && !(a.contentDisposition === 'inline' && /^image\//.test(type) && (a.content?.length || 0) < 30_000))
    .slice(0, MAX_FILES);
  if (!files.length) { await settle('skipped', 'No PDF or photo of a bill attached'); return { status: 'skipped', bills: 0 }; }

  let made = 0;
  for (let i = 0; i < files.length; i++) {
    const { a, type } = files[i];
    const buffer = a.content;
    const doc = { ...base, part: i + 1, filename: String(a.filename || `bill-${i + 1}`).slice(0, 120), contentType: type, size: buffer?.length || 0 };
    if (!buffer || buffer.length > MAX_BYTES) {
      await InboxBill.create({ ...doc, status: 'failed', note: 'The file is over 10 MB' }).catch(() => null);
      continue;
    }
    doc.data = `data:${type};base64,${buffer.toString('base64')}`;
    const startedAt = Date.now();
    let read;
    try {
      read = await readBill([{ buffer, mimetype: type }]);
    } catch (err) {
      await aiLedger.record({ surface: 'bill-ocr', model: '?', promptVersion: promptVersion('bill-ocr'), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
      await InboxBill.create({ ...doc, status: 'failed', note: err.code === 'ANTHROPIC_KEY_MISSING' ? 'Bill reading is not set up on this server — open the file and enter it by hand' : `Could not read it: ${err.message}`.slice(0, 300) }).catch(() => null);
      continue;
    }
    const aiSuggestion = await aiLedger.record({
      surface: 'bill-ocr', model: read.model, promptVersion: promptVersion('bill-ocr'),
      proposed: { kind: read.kind, supplierName: read.supplierName, supplierGstin: read.supplierGstin, billNo: read.billNo, billDate: read.billDate, lines: read.lines, totals: read.totals, confidence: read.confidence },
      latencyMs: read.latencyMs, usage: read.usage,
    }).catch(() => null);
    if (read.problem) {
      await InboxBill.create({ ...doc, status: 'skipped', note: read.problem === 'not_a_bill' ? 'Not a bill' : 'Could not be read', read, aiSuggestion }).catch(() => null);
      continue;
    }
    const match = await matchRead(read);
    const senderKnown = !!(match.supplierEmail && String(match.supplierEmail).toLowerCase().split(/[,;\s]+/).includes(from));
    await InboxBill.create({
      ...doc, status: 'new', read, aiSuggestion,
      supplier: match.supplier?._id || null, supplierName: match.supplier?.name || read.supplierName || '', matchedBy: match.supplier?.matchedBy || null,
      senderKnown, alreadyEntered: match.alreadyEntered, grand: read.totals?.grand ?? null,
      note: match.alreadyEntered ? `Already entered as ${match.alreadyEntered}` : '',
    });
    made += 1;
  }
  await settle('skipped', `${made} bill${made === 1 ? '' : 's'} read from ${files.length} file${files.length === 1 ? '' : 's'}`);
  return { status: 'read', bills: made };
}

let running = false;
async function run({ now = new Date() } = {}) {
  const c = config();
  if (!configured(c) || running) return { ran: false };
  running = true;
  const out = { ran: true, mails: 0, bills: 0, errors: [] };
  try {
    const since = new Date(now.getTime() - c.days * 86_400_000);
    const isKnown = async (id) => !!(await InboxBill.exists({ messageId: id, part: 0 }));
    const mails = await fetcher(c, { since, isKnown });
    for (const raw of mails.slice(0, c.maxPerRun)) {
      try {
        const r = await handle(raw, c);
        if (r.status !== 'known') { out.mails += 1; out.bills += r.bills; }
      } catch (err) { out.errors.push(err.message); }
    }
  } catch (err) {
    out.errors.push(err.message);
  } finally {
    running = false;
  }
  return out;
}

let timer = null;
function start() {
  const c = config();
  if (timer || !configured(c) || !(c.everyMin > 0) || process.env.NODE_ENV === 'test') return null;
  timer = setInterval(() => { run().catch((err) => console.error('[bills-mailbox] run failed:', err?.message)); }, c.everyMin * 60_000);
  timer.unref?.();
  console.log(`[bills-mailbox] reading ${c.user} every ${c.everyMin} min`);
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

function status() {
  const c = config();
  return { configured: configured(c), mailbox: configured(c) ? c.user : '', everyMin: c.everyMin, senders: c.senders };
}

module.exports = { run, start, stop, handle, status, config, configured, setFetcher, senderOk, imapFetch };
