'use strict';
// ══════════════════════════════════════════════════════════════════
//  ANSWERING A CUSTOMER ON WHATSAPP
//
//  A message from a customer's number (their own or their accountant's)
//  is sorted — keywords first, the model only refines — into:
//
//    order_status  "where is my order?", "PO 778 status"      → answered
//    statement     "send statement", "how much is due"          → answered
//    invoice_copy  "send invoice 1182 again"                    → answered,
//                                                                 office told
//    new_order     "2000 m 25mm black by Friday"                → drafted as an
//                                                                 order request
//    money         a promise, "paid", a dispute                 → the payment
//                                                                 reply handler
//    other                                                      → office told
//
//  Every answer is read from the records — orders, challans, the
//  ledger, invoices — never written by the model, and nothing is changed
//  by a message: a typed order is a draft the office opens as an order.
//  Off by default (AccountsSettings.collections.assistant): off, every
//  customer message goes to the payment reply handler as before.
// ══════════════════════════════════════════════════════════════════

const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

const SURFACE = 'customer-assistant';
const INTENTS = ['order_status', 'statement', 'invoice_copy', 'new_order', 'money', 'other'];
const AI_WAIT_MS = Number(process.env.CUSTOMER_ASSISTANT_AI_MS) || 6000;
const money = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }) : '');

/** The words people use, in English, Tamil and Tanglish. Order matters: the first rule that fits wins. */
const RULES = [
  ['invoice_copy', /\b(invoice|bill)\b.*\b(copy|again|resend|send|pdf)\b|\b(copy|resend|send)\b.*\b(invoice|bill)\b/i],
  ['statement', /\b(statement|ledger|outstanding|balance|how much.*(due|pending|pay)|kanakku|baaki|baki)\b/i],
  ['order_status', /\b(status|where|when|eppo|enga|dispatch|despatch|deliver|ready|shipped|sent)\b/i],
  ['money', /\b(paid|pay|payment|cheque|check|utr|neft|rtgs|imps|transfer(red)?|amount|rate (is )?wrong|short|shortage|damage|kaasu|panam|anupp?(i|ich))\b/i],
  ['new_order', /\b\d[\d,]*\s*(m|mtr|mtrs|meter|meters|metre|metres|kg|kgs|pcs|rolls?)\b/i],
];

/** A number they name: an order (#71, order 71), a PO, an invoice. */
function numbersIn(text) {
  const t = String(text || '');
  const order = t.match(/\b(?:order|ord)\s*(?:no\.?|number|#)?\s*:?\s*#?(\d{1,6})\b/i)?.[1] || t.match(/#(\d{1,6})\b/)?.[1];
  const po = t.match(/\bpo\s*(?:no\.?|number|#)?\s*:?\s*([A-Za-z0-9/_-]{2,30})/i)?.[1];
  const invoice = t.match(/\b(?:invoice|inv|bill)\s*(?:no\.?|number|#)?\s*:?\s*([A-Za-z0-9/_-]*\d[A-Za-z0-9/_-]*)/i)?.[1];
  return { orderNo: order ? Number(order) : null, po: po || null, invoice: invoice || null };
}

const QTY = /\b\d[\d,]*\s*(m|mtr|mtrs|meter|meters|metre|metres|kg|kgs|pcs|rolls?)\b/i;
const ASKS = /\b(status|where|enga|eppo|when will|how long)\b/i;

function keywordIntent(text) {
  const t = String(text || '');
  // Quantities are an order — "deliver by Friday" in it does not make it a
  // question — unless it plainly asks where or what status.
  if (QTY.test(t) && !ASKS.test(t) && !RULES[0][1].test(t) && !RULES[1][1].test(t)) return 'new_order';
  for (const [intent, re] of RULES) if (re.test(t)) return intent;
  return 'other';
}

// The object in the model's reply, or null (utils/modelJson.js).
const { parseJson } = require('../utils/modelJson');

/** What the message is. Never throws: the keywords stand when the model is slow, off or unsure. */
async function classify(text, { refId = null } = {}) {
  const base = { intent: keywordIntent(text), ...numbersIn(text), ai: false };
  const claude = anthropic();
  if (!claude) return base;
  const startedAt = Date.now();
  try {
    const prompt = [
      'A customer of an elastic manufacturer in Tamil Nadu sent this WhatsApp message (English, Tamil or Tanglish). Sort it. Return ONLY JSON:',
      '{"intent":"order_status","orderNo":71,"po":"","invoice":"","confidence":0.9}',
      '- intent: order_status = asks where an order is or when it comes; statement = asks for their statement or how much is due;',
      '  invoice_copy = asks for a copy of an invoice; new_order = places an order (items with quantities); money = says they will pay,',
      '  have paid, or disputes an invoice (rate, quantity, quality); other = anything else.',
      '- orderNo: our order number if named, else null. po: their PO number if named, else "". invoice: an invoice number if named, else "".',
      '', `Message:\n"""\n${String(text).slice(0, 1500)}\n"""`,
    ].join('\n');
    const call = claude.messages.create({ model: TEXT_MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    const msg = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), AI_WAIT_MS))]);
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw || !INTENTS.includes(raw.intent)) throw new Error('model returned no intent');
    const out = {
      intent: raw.intent,
      orderNo: Number.isInteger(Number(raw.orderNo)) && Number(raw.orderNo) > 0 ? Number(raw.orderNo) : base.orderNo,
      po: String(raw.po || base.po || '').slice(0, 30) || null,
      invoice: String(raw.invoice || base.invoice || '').slice(0, 40) || null,
      ai: true,
    };
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), refType: 'Customer', refId, proposed: { intent: out.intent, keywords: base.intent, orderNo: out.orderNo, po: out.po, invoice: out.invoice }, latencyMs: Date.now() - startedAt, usage: msg.usage }).catch(() => null);
    return out;
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) }).catch(() => null);
    return base;
  }
}

const STAGE = { Open: 'received, waiting for approval', Approved: 'approved and planned', InProgress: 'in production', Completed: 'completed', Cancelled: 'cancelled' };
const sum = (rows) => (rows || []).reduce((t, r) => t + (Number(r.quantity) || 0), 0);

/** Where their orders are: the one they named, else the ones still open. */
async function orderStatus(customer, { orderNo, po } = {}) {
  const Order = require('../models/Order');
  const DeliveryChallan = require('../models/DeliveryChallan');
  const q = { customer: customer._id, status: { $ne: 'Deleted' } };
  let orders;
  if (orderNo) orders = await Order.find({ ...q, orderNo }).lean();
  else if (po) orders = await Order.find({ ...q, po: new RegExp(`^${String(po).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  // The one they named, not on file: say so, then what is open.
  const asked = orderNo ? `order #${orderNo}` : po ? `PO ${po}` : '';
  const missing = !!asked && !orders?.length;
  if (!orders?.length) orders = await Order.find({ ...q, status: { $in: ['Open', 'Approved', 'InProgress'] } }).sort({ supplyDate: 1 }).limit(5).lean();
  const notFound = missing ? `We could not find ${asked} — our office will check and reply.` : '';
  if (!orders.length) return { text: notFound || `We have no open order for ${customer.name} just now.`, found: 0, askOffice: missing };
  const lines = [];
  for (const o of orders) {
    const ordered = sum(o.elasticOrdered);
    const pending = o.status === 'Completed' ? 0 : sum(o.pendingElastic);
    const sent = Math.max(0, ordered - pending);
    const last = await DeliveryChallan.findOne({ order: o._id, status: { $in: ['dispatched', 'delivered'] } }).sort({ dispatchDate: -1 }).select('dcNumber dispatchDate').lean();
    lines.push(`• Order #${o.orderNo}${o.po ? ` (your PO ${o.po})` : ''}: ${STAGE[o.status] || o.status}` +
      (o.status !== 'Completed' && o.status !== 'Cancelled' && o.supplyDate ? `, due ${dmy(o.supplyDate)}` : '') +
      (ordered ? ` — ${money(sent)} of ${money(ordered)} m sent` : '') +
      (last ? `, last on ${dmy(last.dispatchDate)} (${last.dcNumber})` : ''));
  }
  return { text: [...(notFound ? [notFound, 'Your open orders:'] : [`${customer.name} — your order${orders.length === 1 ? '' : 's'}:`]), ...lines].join('\n'), found: orders.length, askOffice: missing };
}

/** What is due from them, oldest first. */
async function statementSummary(customer) {
  const outstanding = require('./outstanding');
  const credits = require('./credits');
  const rows = await outstanding.receivables({ customer: customer._id });
  const ahead = (await credits.openFor('customer', customer._id)).reduce((t, c) => t + c.available, 0);
  const t = outstanding.totals(rows);
  if (!rows.length && !ahead) return `${customer.name}: nothing is due from you. Thank you!`;
  const out = [`${customer.name} — your account with us:`];
  for (const r of rows.slice(0, 8)) out.push(`• ${r.docNo}${r.refNo ? ` (${r.refNo})` : ''} dated ${dmy(r.date)}: ₹${money(r.outstanding)}${r.overdueDays > 0 ? ` — ${r.overdueDays} days past due` : ''}`);
  if (rows.length > 8) out.push(`• and ${rows.length - 8} more`);
  out.push(`Total due ₹${money(t.total)}${t.overdue > 0 ? `, of which ₹${money(t.overdue)} is past due` : ''}.`);
  if (ahead > 0.005) out.push(`₹${money(ahead)} paid ahead is held for you${ahead + 0.005 >= t.total ? ' — it covers what is due; our office will set it off' : ''}.`);
  out.push('Our accounts team will send the full statement.');
  return out.join('\n');
}

/** The invoice they named, if it is theirs; else their latest. */
async function invoiceInfo(customer, { invoice } = {}) {
  const Invoice = require('../models/Invoice');
  let inv = null;
  if (invoice) {
    const tail = String(invoice).replace(/\D/g, '');
    const cands = await Invoice.find({ customer: customer._id, status: 'issued' }).select('invoiceNumber invoiceDate totals paidAmount creditedAmount debitedAmount dueDate').sort({ invoiceDate: -1 }).limit(200).lean();
    inv = cands.find((c) => c.invoiceNumber.toUpperCase() === String(invoice).toUpperCase()) || (tail ? cands.find((c) => c.invoiceNumber.replace(/\D/g, '').endsWith(tail)) : null);
  }
  if (!inv && !invoice) inv = await Invoice.findOne({ customer: customer._id, status: 'issued' }).sort({ invoiceDate: -1 }).lean();
  if (!inv) return { text: `We could not find invoice ${invoice} for ${customer.name} — our accounts team will check and send it.`, invoiceNo: null };
  const left = Math.round(((inv.totals?.grand || 0) + (inv.debitedAmount || 0) - (inv.paidAmount || 0) - (inv.creditedAmount || 0)) * 100) / 100;
  return {
    text: `Invoice ${inv.invoiceNumber} dated ${dmy(inv.invoiceDate)} for ₹${money(inv.totals?.grand)}${left > 0.005 ? ` — ₹${money(left)} still due${inv.dueDate ? ` (due ${dmy(inv.dueDate)})` : ''}` : ' — fully paid, thank you'}. Our accounts team will send you a copy.`,
    invoiceNo: inv.invoiceNumber,
  };
}

/**
 * The message, handled.
 * @returns { intent, reply } — reply is what to send back, or '' for none
 */
async function handle({ from, text, customer }) {
  const OrderRequest = require('../models/OrderRequest');
  const { notify } = require('../utils/notify');
  const c = await classify(text, { refId: customer._id });
  const tell = (body) => notify('collectionReply', { body, _entity: { type: 'Customer', id: customer._id } }).catch(() => null);
  const quote = `"${String(text).slice(0, 300)}"`;

  if (c.intent === 'money') {
    const r = await require('./collectionReply').handle({ from, text, customer });
    return { intent: c.intent, reply: r.ack };
  }
  if (c.intent === 'order_status') {
    const s = await orderStatus(customer, c);
    if (s.askOffice) await tell(`📦 *${customer.name}* asked about ${c.orderNo ? `order #${c.orderNo}` : `PO ${c.po}`}, which is not on file:\n${quote}`);
    return { intent: c.intent, reply: s.text };
  }
  if (c.intent === 'statement') {
    await tell(`📄 *${customer.name}* asked for their statement — they were told what is due; send the PDF:\n${quote}`);
    return { intent: c.intent, reply: await statementSummary(customer) };
  }
  if (c.intent === 'invoice_copy') {
    const i = await invoiceInfo(customer, c);
    await tell(`🧾 *${customer.name}* asked for ${i.invoiceNo ? `a copy of ${i.invoiceNo}` : `invoice ${c.invoice || '(not named)'}`} — send it:\n${quote}`);
    return { intent: c.intent, reply: i.text };
  }
  if (c.intent === 'new_order') {
    let draft = null; let aiSuggestion = '';
    try {
      const d = await require('./inboundPoIntake').draftFromText(text, { customer });
      if (d?.ok) { draft = d.draft; aiSuggestion = d.aiSuggestionId || ''; }
    } catch { /* kept as typed; the office reads it */ }
    const reqDoc = await OrderRequest.create({ customer: customer._id, customerName: customer.name, from, text: String(text).slice(0, 3000), draft, aiSuggestion });
    const n = draft?.lines?.length || 0;
    await tell(`🛒 *${customer.name}* sent an order on WhatsApp${n ? ` (${n} line${n === 1 ? '' : 's'} read)` : ''} — open it under Orders → WhatsApp orders:\n${quote}`);
    return { intent: c.intent, reply: `Thank you — we have your order${n ? ` (${n} item${n === 1 ? '' : 's'})` : ''}. Our team will confirm it shortly.`, request: reqDoc._id };
  }
  await tell(`💬 *${customer.name}* wrote on WhatsApp:\n${quote}`);
  return { intent: c.intent, reply: 'Thank you — our team will get back to you shortly.' };
}

module.exports = { handle, classify, keywordIntent, numbersIn, orderStatus, statementSummary, invoiceInfo, SURFACE, INTENTS };
