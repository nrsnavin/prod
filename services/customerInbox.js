'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CUSTOMER MAILBOX — every customer mail sent where it belongs
//
//  Customers mail purchase orders, complaints, payment advices and
//  enquiries to one address. Forward that to a mailbox of its own and
//  this reads it every few minutes, works out which of the four it is
//  (keywords first, the model briefly — surface inbox-triage), and hands
//  it to the reader that already exists for it:
//
//    purchase order  → read (inbound-po-ocr / whatsapp-order) into an order
//                      request, beside WhatsApp orders, to confirm
//    complaint       → read (complaint-intake); opened as a complaint when
//                      the job it is about is clear, else kept as a draft
//    payment advice  → read (payment-advice) and placed on the books,
//                      for accounts to enter the receipt from
//    enquiry         → a quote drafted (quote-enquiry)
//
//  The sender is matched to a customer on file by e-mail (their own,
//  purchase contact's, accountant's or merchandiser's). An order or
//  complaint from an unknown sender is kept, not filed under a guess.
//  Nothing is confirmed, posted or sent from here; everything waits for
//  a person in Accounts → Inbox. The office is told (event customerMail).
//
//  Set CUSTOMER_IMAP_HOST, CUSTOMER_IMAP_USER, CUSTOMER_IMAP_PASS (and
//  _PORT, _SECURE, CUSTOMER_MAILBOX, CUSTOMER_MAIL_EVERY_MIN,
//  CUSTOMER_MAIL_MAX_PER_RUN). A mail is claimed before it is read, so
//  two processes never read it twice.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const InboxMail = require('../models/InboxMail');
const Customer = require('../models/Customer');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const SURFACE = 'inbox-triage';
const KINDS = ['purchase_order', 'complaint', 'payment_advice', 'enquiry', 'other'];
const MAX_FILES = 4;
const MAX_BYTES = 10 * 1024 * 1024;
const AI_WAIT_MS = Number(process.env.INBOX_TRIAGE_AI_MS) || 8000;
const FILE_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function config() {
  const e = process.env;
  return {
    host: e.CUSTOMER_IMAP_HOST || '', port: Number(e.CUSTOMER_IMAP_PORT || 993), secure: e.CUSTOMER_IMAP_SECURE !== 'false',
    user: e.CUSTOMER_IMAP_USER || '', pass: e.CUSTOMER_IMAP_PASS || '', mailbox: e.CUSTOMER_MAILBOX || 'INBOX',
    everyMin: e.CUSTOMER_MAIL_EVERY_MIN === undefined ? 10 : Number(e.CUSTOMER_MAIL_EVERY_MIN),
    maxPerRun: Number(e.CUSTOMER_MAIL_MAX_PER_RUN || 20), days: 7,
  };
}
const configured = (c = config()) => !!(c.host && c.user && c.pass);

let fetcher = (c, opts) => require('./billMailbox').imapFetch(c, opts);
/** Tests replace the mailbox with a list of raw messages. */
function setFetcher(fn) { fetcher = fn || ((c, opts) => require('./billMailbox').imapFetch(c, opts)); }

const typeOf = (a) => {
  const t = String(a.contentType || '').toLowerCase().split(';')[0];
  if (Object.values(FILE_TYPES).includes(t)) return t;
  return FILE_TYPES[String(a.filename || '').toLowerCase().split('.').pop()] || null;
};

/** The mail's own words: the reply above any quoted thread, trimmed. */
function bodyOf(mail) {
  const t = String(mail.text || '').replace(/\r/g, '');
  const cut = t.search(/\n(On .{5,80}wrote:|-{2,}\s*Original Message|From: .+\nSent: )/i);
  return (cut > 0 ? t.slice(0, cut) : t).replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
}

/** The customer on file with this e-mail address, any of their contacts. */
async function customerForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const rx = new RegExp(`(^|[,;\\s])${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[,;\\s])`, 'i');
  return Customer.findOne({ $or: [{ email: rx }, { 'purchase.email': rx }, { 'accountant.email': rx }, { 'merchandiser.email': rx }] }).select('name').lean();
}

function keywordKind(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(payment advice|remittance|remitted|payment (details|made|released|done)|we have (paid|transferred)|utr|neft|rtgs|imps)\b/.test(t)) return 'payment_advice';
  if (/\b(complaint|defect\w*|damaged?|rejected|rejection|shade (variation|difference)|short (supply|quantity|received)|quality (issue|problem)|not as per)\b/.test(t)) return 'complaint';
  // A PO named outright, then an ask for rates, then the softer "please supply".
  if (/\b(purchase order|p\.?o\.?\s*(no|number|#)|po\s*\d+|order (attached|enclosed))\b/.test(t)) return 'purchase_order';
  if (/\b(quotation|quote|enquiry|inquiry|rate for|price for|(best|your) (rate|rates|price|prices)|requirement|samples? (for|of))\b/.test(t)) return 'enquiry';
  if (/\b(order for|please (supply|send)|kindly (supply|send))\b/.test(t)) return 'purchase_order';
  return 'other';
}

// The object in the model's reply, or null (utils/modelJson.js).
const { parseJson } = require('../utils/modelJson');

/** What the mail is. Never throws: keywords stand when the model is slow, off or wrong. */
async function classify({ subject, text, filenames }) {
  const words = `${subject}\n${text}\n${filenames.join(' ')}`;
  const base = { kind: keywordKind(words), summary: '', ai: false };
  const claude = anthropic();
  if (!claude) return base;
  const startedAt = Date.now();
  try {
    const prompt = [
      'A mail to an elastic (narrow-fabric) manufacturer in Tamil Nadu, from a customer. Say what it is. Return ONLY JSON:',
      '{"kind":"purchase_order","summary":"PO 4512 for 3 elastics, delivery by 20 Nov"}',
      `kind: one of ${KINDS.join(', ')}. purchase_order = an order to supply goods (often a PO attached); complaint = a problem with goods`,
      'received; payment_advice = says what they paid and for which invoices; enquiry = asks for rates, a quote or samples; other = anything else.',
      'summary: at most 100 characters, English.',
      '', `Subject: ${String(subject).slice(0, 200)}`, `Attachments: ${filenames.join(', ') || 'none'}`, `Body:\n"""\n${String(text).slice(0, 2500)}\n"""`,
    ].join('\n');
    const call = claude.messages.create({ model: TEXT_MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    const msg = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), AI_WAIT_MS))]);
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw || !KINDS.includes(raw.kind)) throw new Error('model returned no kind');
    const out = { kind: raw.kind, summary: String(raw.summary || '').slice(0, 120), ai: true };
    const id = await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), proposed: { kind: out.kind }, latencyMs: Date.now() - startedAt, usage: msg.usage }).catch(() => null);
    return { ...out, aiSuggestion: id ? String(id) : '' };
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) }).catch(() => null);
    return base;
  }
}

/** Hand the mail to its reader. Returns the fields to set on the InboxMail. */
async function route(kind, { customer, text, files, from }) {
  const pages = files.map((f) => ({ buffer: f.buffer, mimetype: f.type }));
  if (kind === 'purchase_order') {
    const intake = require('./inboundPoIntake');
    let d = null;
    try { d = files[0] ? await intake.draftFromDocument(files[0].buffer, files[0].type) : await intake.draftFromText(text, { customer }); } catch (err) { return { status: 'new', note: `The order could not be read: ${err.message}`.slice(0, 300) }; }
    const draft = d?.ok ? d.draft : null;
    if (!customer) return { status: 'new', draft, note: 'Sender not matched to a customer — open it and pick one' };
    const OrderRequest = require('../models/OrderRequest');
    const r = await OrderRequest.create({ customer: customer._id, customerName: customer.name, from, text: String(text || '(see the attached order)').slice(0, 3000), draft, aiSuggestion: d?.aiSuggestionId || '' });
    return { status: 'done', orderRequest: r._id, note: `Order request — ${draft?.lines?.length || 0} line(s) read; confirm it under Orders` };
  }
  if (kind === 'complaint') {
    if (!customer) return { status: 'new', note: 'Sender not matched to a customer — open it and pick one' };
    const r = await require('./complaintIntake').intake({ customer: customer._id, text, images: pages.filter((p) => /^image\//.test(p.mimetype)) });
    const job = r.jobs?.[0];
    if (!job) return { status: 'new', draft: r, aiSuggestion: r.aiSuggestion || '', note: 'Which job it is about is not clear — open it to finish the complaint' };
    const Complaint = require('../models/Complaints');
    const c = await Complaint.create({ customer: customer._id, job: job._id, elastic: r.elastic?._id || undefined, category: r.category || 'other', reason: r.reason || String(text).slice(0, 500), date: new Date(), status: 'Open' });
    return { status: 'done', complaint: c._id, draft: { category: r.category, job: job.jobOrderNo, why: job.why }, aiSuggestion: r.aiSuggestion || '', note: `Complaint opened against job ${job.jobOrderNo ?? ''}`.trim() };
  }
  if (kind === 'payment_advice') {
    let read;
    try { read = await require('../utils/adviceOcr').readAdvice({ pages, text }); } catch (err) { return { status: 'new', note: err.code === 'ANTHROPIC_KEY_MISSING' ? 'Reading advices is not set up — enter the receipt by hand' : `The advice could not be read: ${err.message}`.slice(0, 300) }; }
    const placed = read.problem ? null : await require('./adviceMatch').placeAdvice(read, { customer: customer?._id || null });
    const amount = read.amount ? `₹${Number(read.amount).toLocaleString('en-IN')}` : '';
    return { status: 'new', draft: { read: { ...read, usage: undefined }, placed }, note: read.problem ? 'Not a readable advice' : `Advice ${amount}${placed?.allocations?.length ? ` against ${placed.allocations.length} document(s)` : ''} — enter the receipt` };
  }
  if (kind === 'enquiry') {
    try {
      const out = await require('./quoteEnquiry').draft({ text, pages, customer: customer?._id });
      if (out.read.problem) return { status: 'new', note: 'Not a readable enquiry' };
      const { model, usage, latencyMs, ...read } = out.read;
      return { status: 'new', draft: { ...out, read }, note: `Quote drafted — ${out.lines.length} line(s); open it to check and send` };
    } catch (err) { return { status: 'new', note: `The enquiry could not be read: ${err.message}`.slice(0, 300) }; }
  }
  return { status: 'new', note: '' };
}

const WORDS = { purchase_order: 'sent a purchase order', complaint: 'sent a complaint', payment_advice: 'sent a payment advice', enquiry: 'sent an enquiry', other: 'wrote' };

/** One mail: claimed, read, sent where it belongs. */
async function handle(raw) {
  const { simpleParser } = require('mailparser');
  const mail = await simpleParser(raw.source);
  const messageId = mail.messageId || raw.messageId || `sha-${crypto.createHash('sha256').update(raw.source).digest('hex').slice(0, 32)}`;
  const from = String(mail.from?.value?.[0]?.address || '').toLowerCase();
  try { await InboxMail.create({ messageId, from, subject: String(mail.subject || '').slice(0, 300), receivedAt: mail.date || new Date() }); } catch (err) {
    if (err?.code === 11000) return { status: 'known' };
    throw err;
  }
  const text = bodyOf(mail);
  const files = (mail.attachments || [])
    .map((a) => ({ a, type: typeOf(a) }))
    .filter(({ a, type }) => type && a.content && a.content.length <= MAX_BYTES && !(a.contentDisposition === 'inline' && /^image\//.test(type) && a.content.length < 30_000))
    .slice(0, MAX_FILES)
    .map(({ a, type }) => ({ buffer: a.content, type, filename: String(a.filename || 'attachment').slice(0, 120), size: a.content.length }));
  const customer = await customerForEmail(from);
  const kind = await classify({ subject: mail.subject || '', text, filenames: files.map((f) => f.filename) });
  let out;
  try { out = await route(kind.kind, { customer, text, files, from }); } catch (err) { out = { status: 'new', note: `Could not be handled: ${err.message}`.slice(0, 300) }; }
  await InboxMail.updateOne({ messageId }, { $set: {
    text, files: files.map((f) => ({ filename: f.filename, contentType: f.type, size: f.size })),
    customer: customer?._id || null, customerName: customer?.name || '', kind: kind.kind, summary: kind.summary,
    aiSuggestion: kind.aiSuggestion || out.aiSuggestion || '', ...out,
  } });
  const { notify } = require('../utils/notify');
  await notify('customerMail', { body: `📧 *${customer?.name || from}* ${WORDS[kind.kind]} by mail: ${kind.summary || String(mail.subject || '').slice(0, 120)}${out.note ? `\n${out.note}` : ''}` }).catch(() => null);
  return { status: out.status, kind: kind.kind };
}

/**
 * A photo sent to the WhatsApp number that is a customer's order or a
 * payment advice (services/whatsappPapers.js): read by the reader a
 * mail's attachment goes to, and kept beside the mails in Accounts →
 * Inbox. `customer` is the customer on file when they sent it
 * themselves; one of our people forwarding it leaves it to be picked.
 * → { inboxMail, status, note }
 */
async function fileWhatsApp({ messageId, from, caption = '', kind, pages, customer = null, paper = null, notifyOffice = false }) {
  const extOf = (t) => ({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/webp': 'webp' }[t] || 'jpg');
  const files = (pages || []).slice(0, MAX_FILES).map((p, i) => ({ buffer: p.buffer, type: p.mimetype, filename: `whatsapp-${i + 1}.${extOf(p.mimetype)}`, size: p.buffer.length }));
  const text = String(caption || '').slice(0, 6000);
  await InboxMail.create({ messageId, from, subject: 'WhatsApp photo', receivedAt: new Date(), source: 'whatsapp', paper });
  let out;
  try { out = await route(kind, { customer, text, files, from }); } catch (err) { out = { status: 'new', note: `Could not be handled: ${err.message}`.slice(0, 300) }; }
  const inboxMail = await InboxMail.findOneAndUpdate({ messageId }, { $set: {
    text, files: files.map((f) => ({ filename: f.filename, contentType: f.type, size: f.size })),
    customer: customer?._id || null, customerName: customer?.name || '', kind, summary: '', aiSuggestion: out.aiSuggestion || '', ...out,
  } }, { new: true }).select('-text -draft').lean();
  if (notifyOffice) {
    const { notify } = require('../utils/notify');
    await notify('customerMail', { body: `📱 *${customer?.name || from}* ${WORDS[kind] || 'sent a photo'} on WhatsApp${out.note ? `\n${out.note}` : ''}` }).catch(() => null);
  }
  return { inboxMail, status: out.status, note: out.note || '' };
}

let running = false;
async function run({ now = new Date() } = {}) {
  const c = config();
  if (!configured(c) || running) return { ran: false };
  running = true;
  const out = { ran: true, mails: 0, errors: [] };
  try {
    const since = new Date(now.getTime() - c.days * 86_400_000);
    const isKnown = async (id) => !!(await InboxMail.exists({ messageId: id }));
    for (const raw of (await fetcher(c, { since, isKnown })).slice(0, c.maxPerRun)) {
      try { const r = await handle(raw); if (r.status !== 'known') out.mails += 1; } catch (err) { out.errors.push(err.message); }
    }
  } catch (err) { out.errors.push(err.message); } finally { running = false; }
  return out;
}

let timer = null;
function start() {
  const c = config();
  if (timer || !configured(c) || !(c.everyMin > 0) || process.env.NODE_ENV === 'test') return null;
  timer = setInterval(() => { run().catch((err) => console.error('[customer-mailbox] run failed:', err?.message)); }, c.everyMin * 60_000);
  timer.unref?.();
  console.log(`[customer-mailbox] reading ${c.user} every ${c.everyMin} min`);
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function status() { const c = config(); return { configured: configured(c), mailbox: configured(c) ? c.user : '', everyMin: c.everyMin }; }

module.exports = { run, start, stop, handle, fileWhatsApp, route, status, classify, keywordKind, customerForEmail, bodyOf, setFetcher, config, configured, SURFACE };
