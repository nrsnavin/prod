'use strict';
// ══════════════════════════════════════════════════════════════════
//  PETTY CASH IN ONE LINE
//
//  "Paid 350 auto for yarn", "tea 120", "courier to Tiruppur 90
//  yesterday", "Diesel for generator ₹1,250" — typed, or spoken into
//  the phone and written down by the browser — becomes a cash expense
//  draft: the amount, the day, what it was for, and the head it goes
//  under. Each used to be a form filled field by field.
//
//  read(text) → { draft, problems[], by: 'rules' | 'model', aiSuggestion }
//    draft { amount, date: 'YYYY-MM-DD', description, payee,
//            category: { _id, name } | null, reason }
//
//  Rules read it first: the amount (the figure beside ₹ or Rs., else
//  the first figure that is not a date), the day (today, yesterday, a
//  dd/mm date), and what is left as the description. The head comes
//  from the expenses already entered for the same words
//  (accountsInsights.suggestCategory), else the head the line names,
//  else a head whose kind its words point to (auto and bus to travel,
//  tea to refreshments). Only a line the rules cannot read — no amount,
//  or no head — goes to the model, which picks a head from the firm's
//  own list and never makes one up. A refused or failed call leaves the
//  rules' draft. Nothing is saved: the expense form opens filled in.
// ══════════════════════════════════════════════════════════════════
const ExpenseCategory = require('../models/ExpenseCategory');
const bizDates = require('../utils/bizDates');
const { anthropic } = require('../utils/anthropicClient');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

/** The model asked when the rules cannot read a line (structured output, adaptive thinking). */
const MODEL = process.env.CASH_LINE_MODEL || 'claude-opus-5-5';
const MAX_AMOUNT = 10_00_000;

/** Words that say which kind of head a line is for, and the words such a head's name carries. */
const KINDS = [
  { heads: ['conveyance', 'travel', 'transport', 'vehicle', 'auto'], words: ['auto', 'taxi', 'cab', 'bus', 'train', 'ticket', 'toll', 'parking', 'uber', 'ola', 'rapido', 'petrol', 'fuel', 'bike'] },
  { heads: ['refreshment', 'staff welfare', 'welfare', 'tea', 'food', 'canteen'], words: ['tea', 'coffee', 'snacks', 'snack', 'food', 'lunch', 'dinner', 'breakfast', 'biscuit', 'biscuits', 'water', 'sweets', 'juice', 'meals'] },
  { heads: ['courier', 'postage', 'post'], words: ['courier', 'parcel', 'post', 'speed post', 'dtdc', 'professional', 'tracking'] },
  { heads: ['printing', 'stationery', 'stationary', 'office'], words: ['xerox', 'photocopy', 'print', 'printing', 'stationery', 'stationary', 'pen', 'paper', 'file', 'register', 'ink'] },
  { heads: ['repair', 'maintenance'], words: ['repair', 'repairs', 'electrician', 'plumber', 'welding', 'mechanic', 'servicing', 'rewinding'] },
  { heads: ['power', 'fuel', 'generator', 'diesel'], words: ['diesel', 'generator', 'genset', 'gen set', 'kerosene'] },
  { heads: ['loading', 'coolie', 'labour', 'hamali'], words: ['loading', 'unloading', 'coolie', 'hamali', 'labour charges', 'loadman'] },
  { heads: ['cleaning', 'housekeeping'], words: ['cleaning', 'broom', 'phenyl', 'housekeeping', 'sweeping'] },
];

const lower = (s) => String(s || '').toLowerCase();
const hasWord = (text, w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text);

/** The amount, the day and what is left, by rules. */
function byRules(text, today) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  let s = ` ${raw} `;
  let date = today;
  const t = lower(s);
  if (/\byesterday\b/.test(t)) { date = new Date(today.getTime() - bizDates.DAY); s = s.replace(/\byesterday\b/i, ' '); }
  s = s.replace(/\btoday\b/i, ' ');
  // A day written as dd/mm or dd-mm(-yyyy), in this year unless it says otherwise.
  s = s.replace(/\b(?:on\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/, (m, d, mo, y) => {
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : bizDates.parts(today).y;
    const at = bizDates.at(year, Number(mo), Number(d));
    if (at.getUTCDate() === Number(d) && at.getUTCMonth() === Number(mo) - 1 && at <= today) { date = at; return ' '; }
    return m;
  });
  let amount = null;
  const money = /(?:₹|rs\.?|inr|rupees?)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|rs\.?|rupees?|\/-)/i;
  const m1 = s.match(money);
  if (m1) { amount = Number((m1[1] || m1[2]).replace(/,/g, '')); s = s.replace(m1[0], ' '); } else {
    const m2 = s.match(/(?:^|\s)(\d[\d,]*(?:\.\d{1,2})?)(?=\s|$)/);
    if (m2 && m2[1].replace(/,/g, '').length < 9) { amount = Number(m2[1].replace(/,/g, '')); s = s.replace(m2[1], ' '); }
  }
  if (!(amount > 0) || amount > MAX_AMOUNT) amount = null;
  const paidTo = s.match(/\bpaid\s+to\s+([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3})/);
  const payee = paidTo ? paidTo[1].trim() : '';
  let description = s.replace(/\b(paid|pay|spent|given|gave|cash|for the|for|to|towards|on|by)\b/gi, (w) => (/^(for|to|on)$/i.test(w) ? w : ' '))
    .replace(/\s+/g, ' ').trim().replace(/^(for|to|on)\s+/i, '');
  if (!description) description = raw;
  description = description.charAt(0).toUpperCase() + description.slice(1);
  return { amount, date, description: description.slice(0, 200), payee: payee.slice(0, 120) };
}

/** The head: learned from past entries, named in the line, or of the kind its words point to. */
async function headFor(text, description, categories) {
  const t = lower(text);
  const insights = require('./accountsInsights');
  const learned = await insights.suggestCategory({ description }).catch(() => null);
  if (learned?.category) {
    const c = categories.find((x) => String(x._id) === String(learned.category));
    if (c) return { category: c, reason: learned.reason || `as before for “${description}”` };
  }
  const named = categories.find((c) => lower(c.name).split(/[^a-z]+/).filter((w) => w.length >= 4).some((w) => hasWord(t, w)));
  if (named) return { category: named, reason: `the line names ${named.name}` };
  for (const k of KINDS) {
    const word = k.words.find((w) => hasWord(t, w));
    if (!word) continue;
    const c = categories.find((x) => k.heads.some((h) => lower(x.name).includes(h)));
    if (c) return { category: c, reason: `“${word}” goes under ${c.name}` };
  }
  return null;
}

/** The model, for a line the rules could not read: a head from our list only. */
async function byModel(text, categories, today) {
  const claude = anthropic();
  if (!claude) return null;
  const names = categories.map((c) => c.name);
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['amount', 'day', 'description', 'payee', 'head'],
    properties: {
      amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      day: { anyOf: [{ type: 'string', enum: ['today', 'yesterday'] }, { type: 'string', format: 'date' }, { type: 'null' }] },
      description: { type: 'string' },
      payee: { type: 'string' },
      head: names.length ? { anyOf: [{ type: 'string', enum: names }, { type: 'null' }] } : { type: 'null' },
    },
  };
  const startedAt = Date.now();
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{
      role: 'user',
      content: `Someone at an elastic weaving factory in India noted cash they spent (English, Tamil or Tanglish, maybe written down by a phone):\n"${String(text).slice(0, 300)}"\n\nToday is ${bizDates.dmy(today, '/')}. Return the amount in rupees (null if no amount is said; never guess one), the day (today, yesterday, or a date), a short description of what it was for, who was paid if a name is said (else ""), and the expense head it goes under, chosen from the firm's own heads, or null if none fits.`,
    }],
  });
  const reply = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out = null;
  if (msg.stop_reason !== 'refusal') { try { out = JSON.parse(reply); } catch (_) { out = null; } }
  return { out, model: MODEL, usage: msg.usage, latencyMs: Date.now() - startedAt, stop: msg.stop_reason };
}

async function read(text, { by } = {}) {
  const line = String(text || '').trim().slice(0, 300);
  const problems = [];
  if (!line) return { draft: null, problems: ['Type or say what the cash was spent on, and how much'], by: 'rules', aiSuggestion: null };
  const today = bizDates.today();
  const categories = await ExpenseCategory.find({ active: { $ne: false } }).select('name').sort({ name: 1 }).lean();
  const r = byRules(line, today);
  let head = await headFor(line, r.description, categories);
  let source = 'rules';
  let ai = null;
  if (r.amount == null || !head) {
    try {
      ai = await byModel(line, categories, today);
    } catch (err) {
      console.warn(`[cash-line] the model could not be asked: ${err.message}`);
    }
    const o = ai?.out;
    if (o) {
      source = 'model';
      if (r.amount == null && typeof o.amount === 'number' && o.amount > 0 && o.amount <= MAX_AMOUNT) r.amount = Math.round(o.amount * 100) / 100;
      if (o.day === 'yesterday') r.date = new Date(today.getTime() - bizDates.DAY);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(o.day || ''))) { const d = new Date(`${o.day}T00:00:00Z`); if (d <= today) r.date = d; }
      if (o.description) r.description = String(o.description).slice(0, 200);
      if (!r.payee && o.payee) r.payee = String(o.payee).slice(0, 120);
      if (!head && o.head) {
        const c = categories.find((x) => x.name === o.head);
        if (c) head = { category: c, reason: 'suggested from the line' };
      }
    }
  }
  if (r.amount == null) problems.push('No amount was found: type it in');
  if (!head) problems.push('No expense head fits: pick one');
  const draft = {
    amount: r.amount, date: r.date.toISOString().slice(0, 10), description: r.description, payee: r.payee,
    category: head ? { _id: String(head.category._id), name: head.category.name } : null, reason: head?.reason || '',
  };
  const aiSuggestion = await aiLedger.record({
    surface: 'cash-line', model: source === 'model' ? ai.model : 'rules', promptVersion: promptVersion('cash-line'),
    proposed: { amount: draft.amount, date: draft.date, description: draft.description, category: draft.category?._id || null },
    latencyMs: ai?.latencyMs || 0, usage: ai?.usage, refType: by ? 'user' : undefined, refId: by || undefined,
  }).catch(() => null);
  return { draft, problems, by: source, aiSuggestion };
}

module.exports = { read, byRules, headFor, KINDS, MODEL };
