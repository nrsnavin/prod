'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S WHATSAPP REPLY ABOUT MONEY THEY OWE
//
//  A customer answers a payment reminder on WhatsApp ("will pay 50,000
//  on 15th", "paid yesterday UTR 1234…", "invoice 702 rate is wrong").
//  The signed inbound webhook (api/notify.js) hands it here when the
//  number is a customer's or their accountant's on file. It is read —
//  keywords first, the model when set up, briefly — and:
//
//    • kept in the customer's collection history, as they wrote it;
//    • a promise to pay is recorded as one (by when, how much), so the
//      collections list holds them until that day, as a promise taken
//      on the phone does;
//    • the office is told (notification event collectionReply), with
//      what was read — a payment with its reference, a dispute, a
//      request for the statement;
//    • the customer gets a short acknowledgement, when that is on
//      (AccountsSettings.collections.acknowledgeReplies).
//
//  Nothing is posted or settled from a reply: a "paid" is matched when
//  the money shows on the bank statement.
// ══════════════════════════════════════════════════════════════════

const Customer = require('../models/Customer');
const { indiaDay } = require('../utils/indiaLabel');
const cal = require('../utils/bizDates');
const factoryDay = require('../utils/factoryDay');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const collections = require('./collections');

const SURFACE = 'collection-reply';
const KINDS = ['promise', 'paid', 'dispute', 'statement', 'other'];
const AI_WAIT_MS = Number(process.env.COLLECTION_REPLY_AI_MS) || 6000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = 86_400_000;

// TODAY IS THE DAY IT IS IN INDIA. A reply is read from "today": the day
// "tomorrow" follows, the weekday "Monday" is counted from, the date the
// model is told. It was taken from the server's own clock, which is kept
// on UTC and does not turn until 05:30 in India — a customer writing
// "will pay tomorrow" at a quarter to two in the morning was promised
// for today. Days here are calendar days, kept at UTC midnight.
/** The day it is in India at `today` (a moment or a calendar date). */
const dayOf = (today) => cal.dayOf(today) || cal.today();
/** "2026-11-06" of a calendar day. */
const iso = (d) => d.toISOString().slice(0, 10);
/** That day of that month, when there is one (not the 31st of November, not month 13). */
const realDay = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const x = cal.at(y, m, d);
  return x.getUTCMonth() === m - 1 ? x : null;
};
const money = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** The customer whose number (their own or their accountant's) this is. */
async function customerForPhone(phone) {
  const want = collections.e164(phone);
  if (!want) return null;
  const all = await Customer.find({ $or: [{ phoneNumber: { $ne: '' } }, { 'accountant.mobile': { $exists: true } }] }).select('name phoneNumber contactName accountant').lean();
  return all.find((c) => collections.e164(c.phoneNumber) === want || (c.accountant?.mobile && collections.e164(c.accountant.mobile) === want)) || null;
}

/** A date written the way people write it in a chat, from `today`; null when there is none. */
function dateIn(text, today = new Date()) {
  const t = String(text || '').toLowerCase();
  const base = dayOf(today);
  const { y: thisYear, m: thisMonth } = cal.parts(base);
  const plus = (n) => new Date(base.getTime() + n * DAY);
  if (/\bday after tomorrow\b/.test(t)) return plus(2);
  if (/\btomorrow\b|\btmrw\b|\bnaalai\b|நாளை/.test(t)) return plus(1);
  if (/\btoday\b|\btoday itself\b|இன்று/.test(t)) return base;
  if (/\bnext week\b/.test(t)) return plus(7);
  if (/\bmonth[- ]?end\b|\bend of (the )?month\b/.test(t)) return cal.at(thisYear, thisMonth + 1, 0);
  // A date written out, day first. One that does not exist ("31/11", "5/13")
  // is no date: it used to be rolled into the next month, or the next year.
  let m = t.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : thisYear;
    const d = realDay(y, Number(m[2]), Number(m[1]));
    if (!d) return null;
    return !m[3] && d < base ? realDay(y + 1, Number(m[2]), Number(m[1])) : d;
  }
  m = t.match(/\b(?:on|by|before)?\s*(\d{1,2})(?:st|nd|rd|th)\b/) || t.match(/\b(?:on|by|before)\s+(\d{1,2})\b(?![\d,.]|\s*(?:lakh|lac|k|thousand|%))/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 31) {
      // "By the 31st" in a month of thirty days is its last day.
      const d = cal.dayOfMonth(thisYear, thisMonth, n);
      return d < base ? cal.dayOfMonth(thisYear, thisMonth + 1, n) : d;
    }
  }
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wd >= 0) return plus(((wd - base.getUTCDay() + 7) % 7) || 7);
  return null;
}

/** An amount, when it is written as money ("Rs 50,000", "₹1.2 lakh", "50k"). */
function amountIn(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  let m = t.match(/(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l)\b/);
  if (m) return Math.round(Number(m[1]) * 100000);
  m = t.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = t.match(/(?:rs\.?|₹|inr)\s*(\d+(?:\.\d+)?)/) || t.match(/(\d+(?:\.\d+)?)\s*(?:rs|rupees|\/-)/);
  return m ? Number(m[1]) : null;
}

function referenceIn(text) {
  const m = String(text || '').match(/\b(?:utr|ref(?:erence)?|txn|transaction(?: id)?|cheque(?: no)?|chq(?: no)?)\s*(?:no\.?|number|id)?\s*[:#-]?\s*([A-Z0-9]{6,22})\b/i)
    || String(text || '').match(/\b([A-Z]{4}\d{6,18}|\d{12,22})\b/);
  return m ? m[1].toUpperCase() : '';
}

function keywordRead(text, today = new Date()) {
  const t = String(text || '').toLowerCase();
  const date = dateIn(t, today);
  const amount = amountIn(t);
  const reference = referenceIn(text);
  let kind = 'other';
  if (/\b(wrong|not received|short(age)?|damaged?|defect\w*|return(ed)?|dispute|excess|incorrect|mistake|not ordered|rate (is )?(wrong|high))\b/.test(t)) kind = 'dispute';
  else if (/\b(statement|ledger|soa|invoice copy|copy of (the )?invoice|send (the )?details|outstanding details)\b/.test(t)) kind = 'statement';
  else if (/\b(paid|transferred|sent the payment|payment (is )?done|done the payment|credited|cleared)\b/.test(t) || (reference && /\b(utr|neft|rtgs|imps)\b/.test(t))) kind = 'paid';
  else if (/\b(will|shall|going to|can|try to)\s+(pay|transfer|send|clear)\b|\bpay(ing|ment)?\b.*\b(by|on|before|tomorrow|next|month end|this week)\b|\bpayment\b.*\b(tomorrow|next week|month end)\b/.test(t) || (date && /\bpay|payment|transfer|cheque\b/.test(t))) kind = 'promise';
  return { kind, date: date ? iso(date) : null, amount, reference, summary: '', ai: false };
}

// The object in the model's reply, or null (utils/modelJson.js).
const { parseJson } = require('../utils/modelJson');

/** What the reply says. Never throws: keywords stand when the model is slow, off or wrong. */
async function readReply(text, { today = new Date(), refId = null } = {}) {
  const base = keywordRead(text, today);
  const claude = anthropic();
  if (!claude) return base;
  const now = dayOf(today);
  const startedAt = Date.now();
  try {
    const prompt = [
      `Today is ${iso(now)} (${WEEKDAYS[now.getUTCDay()]}). A customer of an elastic manufacturer in Tamil Nadu replied on WhatsApp`,
      'to a reminder about invoices past due. The reply may be English, Tamil or Tanglish. Say what it is. Return ONLY JSON:',
      '{"kind":"promise","date":"2026-11-15","amount":50000,"reference":"","summary":"Will pay 50,000 on 15 Nov","confidence":0.8}',
      `- kind: one of ${KINDS.join(', ')}. promise = says they will pay by a date; paid = says it is already paid; dispute = questions`,
      '  an invoice (rate, quantity, quality, not received); statement = asks for the statement or invoice copies; other = anything else.',
      '- date: the day promised (YYYY-MM-DD, worked out from today), else null. amount: rupees as a number when said, else null.',
      '- reference: a UTR, cheque or transaction number when given, else "". summary: at most 80 characters, English.',
      '', `Reply:\n"""\n${String(text).slice(0, 1500)}\n"""`,
    ].join('\n');
    const call = claude.messages.create({ model: TEXT_MODEL, max_tokens: 250, messages: [{ role: 'user', content: prompt }] });
    const msg = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), AI_WAIT_MS))]);
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw || !KINDS.includes(raw.kind)) throw new Error('model returned no kind');
    // The model's day, when it is one: a day that exists ("2026-11-31" was
    // kept, and became the 1st of December), and for a promise not one that
    // has gone — "on the 15th" from a model a year out was a promise already
    // broken. Otherwise what the reply's own words say, if they say a day.
    let date = factoryDay.isDayKey(String(raw.date || '')) ? raw.date : base.date;
    if (raw.kind === 'promise' && date && date < iso(now)) date = base.date && base.date >= iso(now) ? base.date : null;
    const amount = Number.isFinite(Number(raw.amount)) && Number(raw.amount) > 0 ? Number(raw.amount) : base.amount;
    const out = { kind: raw.kind, date, amount, reference: String(raw.reference || base.reference || '').toUpperCase().slice(0, 30), summary: String(raw.summary || '').slice(0, 100), ai: true };
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), refType: 'Customer', refId, proposed: { kind: out.kind, date: out.date, amount: out.amount }, latencyMs: Date.now() - startedAt, usage: msg.usage }).catch(() => null);
    return out;
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) }).catch(() => null);
    return base;
  }
}

const WORDS = {
  promise: (r) => `promises to pay${r.amount ? ` ₹${money(r.amount)}` : ''}${r.date ? ` by ${indiaDay(r.date, { day: '2-digit', month: 'short' })}` : ''}`,
  paid: (r) => `says it is paid${r.reference ? ` (ref ${r.reference})` : ''} — match it on the bank statement`,
  dispute: () => 'questions an invoice — call them',
  statement: () => 'asks for the statement',
  other: () => 'replied',
};

/**
 * The reply, handled: kept, a promise recorded, the office told.
 * @returns { read, ack } — ack is the text to send back, or '' for none
 */
async function handle({ from, text, customer, today = new Date() }) {
  const read = await readReply(text, { today, refId: customer._id });
  const by = { _id: null, name: 'WhatsApp (customer)' };
  await collections.log({ customer: customer._id, kind: 'reply', channel: 'whatsapp', to: from, message: text, note: `${read.kind}${read.summary ? `: ${read.summary}` : ''}`, user: by });
  // A promise needs its day: one without is kept as said, not as a promise.
  if (read.kind === 'promise' && read.date) {
    await collections.log({ customer: customer._id, kind: 'promise', channel: 'whatsapp', to: from, note: read.summary || String(text).slice(0, 200), promiseDate: new Date(read.date), promiseAmount: read.amount || 0, user: by });
  }
  const { notify } = require('../utils/notify');
  await notify('collectionReply', {
    body: `💬 *${customer.name}* ${WORDS[read.kind](read)}:\n"${String(text).slice(0, 300)}"`,
    _entity: { type: 'Customer', id: customer._id },
  }).catch(() => null);

  const settings = await require('./booksLock').getSettings().catch(() => null);
  if (!settings?.collections?.acknowledgeReplies) return { read, ack: '' };
  const ack = read.kind === 'promise' && read.date ? `Thank you — noted${read.amount ? ` ₹${money(read.amount)}` : ' your payment'} by ${indiaDay(read.date, { day: '2-digit', month: 'short', year: 'numeric' })}.`
    : read.kind === 'paid' ? 'Thank you — we will match it with our bank and confirm.'
      : read.kind === 'statement' ? 'Thank you — our accounts team will send the statement shortly.'
        : read.kind === 'dispute' ? 'Thank you — our accounts team will look into it and call you.'
          : 'Thank you — our accounts team will get back to you.';
  return { read, ack };
}

module.exports = { handle, readReply, keywordRead, dateIn, amountIn, referenceIn, customerForPhone, SURFACE };
