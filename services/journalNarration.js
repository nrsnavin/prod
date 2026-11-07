'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NARRATION FOR A JOURNAL
//
//  suggest({ lines, purpose }) → { suggestions[{ text, from }], usage }
//    lines are the journal's resolved lines ({ ledger, debit, credit }).
//    1. past  — narrations already used on journals with the same
//               ledgers, newest first: the house's own wording
//    2. model — one line in the accountant's style ("Being …"), from
//               the lines; refused if it states an amount not on them
//    3. rule  — "Being ₹X transferred from A to B", always there
//  The person picks one, edits it, or writes their own.
// ══════════════════════════════════════════════════════════════════

const Journal = require('../models/Journal');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const PURPOSE = { setoff: 'set-off', writeoff: 'write-off', accrual: 'provision', salary: 'salary', depreciation: 'depreciation', stock: 'stock adjustment', reclass: 'reclassification', other: 'adjustment' };

function byRule(lines, purpose) {
  const dr = lines.filter((l) => l.debit > 0); const cr = lines.filter((l) => l.credit > 0);
  const total = dr.reduce((s, l) => s + l.debit, 0);
  const names = (xs) => (xs.length <= 2 ? xs.map((l) => l.ledger).join(' and ') : `${xs[0].ledger} and ${xs.length - 1} others`);
  if (purpose === 'writeoff') return `Being ${inr(total)} written off from ${names(cr)} to ${names(dr)}`;
  if (purpose === 'depreciation') return `Being depreciation of ${inr(total)} charged on ${names(cr)}`;
  if (purpose === 'accrual') return `Being ${inr(total)} provided for ${names(dr)}, payable to ${names(cr)}`;
  if (purpose === 'setoff') return `Being ${inr(total)} set off between ${names(dr)} and ${names(cr)}`;
  return `Being ${inr(total)} ${PURPOSE[purpose] || 'transferred'} from ${names(cr)} to ${names(dr)}`;
}

async function past(lines) {
  const ledgers = [...new Set(lines.map((l) => l.ledger))].sort();
  const rows = await Journal.find({ status: 'posted', narration: { $nin: ['', null] }, 'lines.ledger': { $all: ledgers } })
    .select('narration lines.ledger').sort({ date: -1 }).limit(50).lean();
  const same = rows.filter((j) => { const set = [...new Set(j.lines.map((l) => l.ledger))].sort(); return set.length === ledgers.length && set.every((x, i) => x === ledgers[i]); });
  return [...new Set(same.map((j) => j.narration.trim()))].slice(0, 3);
}

/** Every amount the narration states must be one of the journal's. */
function amountsHold(text, lines) {
  const allowed = new Set(lines.flatMap((l) => [l.debit, l.credit]).filter((n) => n > 0).map((n) => String(Math.round(n * 100) / 100)));
  allowed.add(String(Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100));
  const said = (String(text).match(/₹\s?[\d,]+(\.\d+)?|\b\d{3,}(,\d{2,3})*(\.\d+)?\b/g) || []).map((x) => String(Number(x.replace(/[₹,\s]/g, ''))));
  return said.every((n) => allowed.has(n));
}

async function byModel(lines, purpose) {
  const claude = anthropic();
  if (!claude) return null;
  const msg = await claude.messages.create({
    model: TEXT_MODEL, max_tokens: 120,
    messages: [{ role: 'user', content: `Write ONE narration line (at most 20 words) for this Indian accounting journal entry, in the usual style starting "Being". Use ₹ and Indian digit grouping. Do not state any amount that is not below. Reply with the line only.\nPurpose: ${PURPOSE[purpose] || 'adjustment'}\n${lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.ledger} ${l.debit || l.credit}${l.note ? ` (${l.note})` : ''}`).join('\n')}` }],
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').split('\n')[0].replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 300);
  if (!text || !amountsHold(text, lines)) return null;
  return { text, usage: msg.usage };
}

async function suggest({ lines, purpose = 'other' }) {
  const suggestions = [];
  for (const t of await past(lines)) suggestions.push({ text: t, from: 'past' });
  let usage = null;
  try {
    const m = await byModel(lines, purpose);
    if (m && !suggestions.some((s) => s.text.toLowerCase() === m.text.toLowerCase())) { suggestions.push({ text: m.text, from: 'model' }); usage = m.usage; }
  } catch { /* the rule's line is there either way */ }
  const rule = byRule(lines, purpose);
  if (!suggestions.some((s) => s.text.toLowerCase() === rule.toLowerCase())) suggestions.push({ text: rule, from: 'rule' });
  return { suggestions: suggestions.slice(0, 4), usage };
}

module.exports = { suggest, byRule, amountsHold };
