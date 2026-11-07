'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MONTH, IN PLAIN WORDS — what changed and why
//
//  review(month) → { month, figures, points[], by }
//    figures  computed here, against the month before:
//      sales (taxable, from issued invoices) and metres invoiced; the top
//      customers and elastics and how their share moved; purchases
//      (supplier bills); yarn issued and its cost a metre woven; expense
//      heads well above their usual (the three months before); what is
//      overdue from customers today
//    points   four to six lines saying what moved and why. Written by the
//      model over the figures — and refused if it states a number the
//      figures do not hold — else put together from the figures by rule.
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const MaterialOutward = require('../models/MaterialOut.cjs');
const ShiftDetail = require('../models/ShiftDetail');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');

const IST = '+05:30';
const r0 = (n) => Math.round(n || 0);
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
const inr = (n) => `₹${r0(n).toLocaleString('en-IN')}`;

function bounds(month) {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(`${month}-01T00:00:00${IST}`);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from, to: new Date(`${next}-01T00:00:00${IST}`) };
}
function shift(month, by) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const label = (month) => new Date(`${month}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

async function salesOf(month) {
  const { from, to } = bounds(month);
  const invs = await Invoice.find({ status: 'issued', invoiceDate: { $gte: from, $lt: to } }).select('customer buyer.name totals lines.elastic lines.name lines.quantity lines.unit lines.taxable').lean();
  const byCustomer = new Map(); const byElastic = new Map();
  let taxable = 0; let metres = 0;
  for (const inv of invs) {
    taxable += inv.totals?.taxable || 0;
    const ck = inv.buyer?.name || String(inv.customer);
    byCustomer.set(ck, (byCustomer.get(ck) || 0) + (inv.totals?.taxable || 0));
    for (const l of inv.lines || []) {
      if (!l.unit || l.unit === 'm') metres += l.quantity || 0;
      const ek = l.name || 'Other';
      byElastic.set(ek, (byElastic.get(ek) || 0) + (l.taxable || 0));
    }
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value]) => ({ name, value: r0(value), share: taxable ? Math.round((value / taxable) * 1000) / 10 : 0 }));
  return { taxable: r0(taxable), invoices: invs.length, metres: r0(metres), customers: top(byCustomer), elastics: top(byElastic), byCustomer };
}

async function purchasesOf(month) {
  const { from, to } = bounds(month);
  const rows = await SupplierBill.aggregate([{ $match: { status: { $ne: 'cancelled' }, billDate: { $gte: from, $lt: to } } }, { $group: { _id: null, taxable: { $sum: '$totals.taxable' }, n: { $sum: 1 } } }]);
  return { taxable: r0(rows[0]?.taxable), bills: rows[0]?.n || 0 };
}

async function yarnOf(month) {
  const { from, to } = bounds(month);
  const [issued] = await MaterialOutward.aggregate([
    { $match: { reversed: { $ne: true }, outwardDate: { $gte: from, $lt: to } } },
    { $group: { _id: null, kg: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', { $ifNull: ['$unitPrice', 0] }] } } } },
  ]);
  const [woven] = await ShiftDetail.aggregate([
    { $match: { status: 'closed', date: { $gte: from, $lt: to } } },
    { $group: { _id: null, metres: { $sum: { $ifNull: ['$productionMeters', 0] } } } },
  ]);
  const metres = woven?.metres || 0; const value = issued?.value || 0;
  return { kg: r2(issued?.kg), value: r0(value), metresWoven: r0(metres), perMetre: metres > 0 && value > 0 ? r2(value / metres) : null };
}

async function expensesOf(month) {
  const head = async (m) => {
    const { from, to } = bounds(m);
    const rows = await Expense.aggregate([{ $match: { status: { $in: ['approved', 'paid'] }, date: { $gte: from, $lt: to } } }, { $group: { _id: '$categoryName', amount: { $sum: '$totals.grand' } } }]);
    return new Map(rows.map((r) => [r._id || 'Other', r.amount]));
  };
  const now = await head(month);
  const before = [];
  for (const back of [1, 2, 3]) before.push(await head(shift(month, -back)));
  const unusual = [];
  for (const [name, amount] of now) {
    const usual = before.reduce((s, m) => s + (m.get(name) || 0), 0) / 3;
    if (amount >= 5000 && (usual === 0 || amount >= usual * 1.5)) unusual.push({ name, amount: r0(amount), usual: r0(usual) });
  }
  unusual.sort((a, b) => (b.amount - b.usual) - (a.amount - a.usual));
  return { total: r0([...now.values()].reduce((s, v) => s + v, 0)), unusual: unusual.slice(0, 4) };
}

async function overdueNow() {
  const { receivables } = require('./outstanding');
  const rows = await receivables({});
  const due = rows.filter((r) => r.overdueDays > 0);
  return { amount: r0(due.reduce((s, r) => s + r.outstanding, 0)), over60: r0(due.filter((r) => r.overdueDays > 60).reduce((s, r) => s + r.outstanding, 0)), parties: new Set(due.map((r) => String(r.party))).size };
}

async function figures(month) {
  const prev = shift(month, -1);
  const [s, sp, p, pp, y, yp, e, o] = [await salesOf(month), await salesOf(prev), await purchasesOf(month), await purchasesOf(prev), await yarnOf(month), await yarnOf(prev), await expensesOf(month), await overdueNow()];
  // Share moves: who grew or shrank most against last month.
  const moves = [];
  for (const c of s.customers) {
    const before = sp.byCustomer.get(c.name) || 0;
    moves.push({ name: c.name, now: c.value, before: r0(before), change: pct(c.value, before) });
  }
  for (const [name, v] of sp.byCustomer) if (!s.byCustomer.has(name) && v >= sp.taxable * 0.1) moves.push({ name, now: 0, before: r0(v), change: -100 });
  delete s.byCustomer; delete sp.byCustomer;
  return {
    month, label: label(month), previous: label(prev),
    sales: { ...s, previous: sp.taxable, change: pct(s.taxable, sp.taxable), ratePerMetre: s.metres ? r2(s.taxable / s.metres) : null, previousRatePerMetre: sp.metres ? r2(sp.taxable / sp.metres) : null },
    customerMoves: moves.filter((m) => m.change == null || Math.abs(m.change) >= 20).slice(0, 4),
    purchases: { ...p, previous: pp.taxable, change: pct(p.taxable, pp.taxable) },
    yarn: { ...y, previousPerMetre: yp.perMetre, change: y.perMetre && yp.perMetre ? pct(y.perMetre, yp.perMetre) : null },
    expenses: e,
    overdue: o,
  };
}

function byRule(f) {
  const out = [];
  if (f.sales.taxable || f.sales.previous) {
    out.push(`Sales ${inr(f.sales.taxable)}${f.sales.change != null ? ` — ${f.sales.change >= 0 ? 'up' : 'down'} ${Math.abs(f.sales.change)}% on ${f.previous}` : ''}${f.sales.metres ? `, ${f.sales.metres.toLocaleString('en-IN')} m invoiced` : ''}.`);
  }
  if (f.sales.ratePerMetre && f.sales.previousRatePerMetre && Math.abs(pct(f.sales.ratePerMetre, f.sales.previousRatePerMetre)) >= 5) {
    out.push(`Average rate ₹${f.sales.ratePerMetre}/m against ₹${f.sales.previousRatePerMetre}/m — the mix moved.`);
  }
  for (const m of f.customerMoves.slice(0, 2)) {
    out.push(m.now === 0 ? `${m.name} bought nothing this month (${inr(m.before)} last month).` : m.before === 0 ? `${m.name} is new this month at ${inr(m.now)}.` : `${m.name} ${m.change > 0 ? 'up' : 'down'} ${Math.abs(m.change)}% to ${inr(m.now)}.`);
  }
  if (f.yarn.perMetre) out.push(`Yarn cost ₹${f.yarn.perMetre} a metre woven${f.yarn.change != null ? ` (${f.yarn.change >= 0 ? 'up' : 'down'} ${Math.abs(f.yarn.change)}%)` : ''}.`);
  for (const x of f.expenses.unusual.slice(0, 2)) out.push(x.usual ? `${x.name}: ${inr(x.amount)} against a usual ${inr(x.usual)}.` : `${x.name}: ${inr(x.amount)}, new this month.`);
  if (f.overdue.amount) out.push(`${inr(f.overdue.amount)} overdue from ${f.overdue.parties} customer${f.overdue.parties === 1 ? '' : 's'} today${f.overdue.over60 ? `, ${inr(f.overdue.over60)} of it over 60 days` : ''}.`);
  return out.slice(0, 6);
}

/** Every number in `text` must appear in the figures; otherwise the text is not used. */
function numbersHold(text, f) {
  const facts = JSON.stringify(f).replace(/,/g, '');
  const nums = (String(text).match(/\d[\d,]*(\.\d+)?/g) || []).map((n) => n.replace(/,/g, '')).filter((n) => n.length > 1 || Number(n) > 9);
  return nums.every((n) => facts.includes(n) || facts.includes(String(Number(n))));
}

async function byModel(f) {
  const claude = anthropic();
  if (!claude) return null;
  const startedAt = Date.now();
  const msg = await claude.messages.create({
    model: TEXT_MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: `You write the month-end note for the owner of an elastic weaving factory in India. From these figures only, give 4 to 6 short lines, each starting "- ", on what changed against last month and the likely why (mix, a customer, yarn cost, an unusual expense, money overdue). Use ₹ and Indian digit grouping. Do not state any number that is not in the figures, and do not add up or compute new ones.\n\n${JSON.stringify(f)}` }],
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const points = text.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 6);
  return { points, usage: msg.usage, latencyMs: Date.now() - startedAt };
}

async function review(month) {
  const f = await figures(month);
  let points = null; let by = 'rules';
  try {
    const m = await byModel(f);
    if (m && m.points.length >= 2) {
      const ok = numbersHold(m.points.join(' '), f);
      const aiLedger = require('./aiLedger');
      const { promptVersion } = require('../utils/aiPrompts');
      await aiLedger.record({ surface: 'month-commentary', model: TEXT_MODEL, promptVersion: promptVersion('month-commentary'), proposed: { points: m.points, numbersHold: ok }, latencyMs: m.latencyMs, usage: m.usage }).catch(() => null);
      if (ok) { points = m.points; by = 'model'; }
    }
  } catch { /* the rules say it from the same figures */ }
  if (!points) points = byRule(f);
  return { month, figures: f, points, by };
}

module.exports = { review, figures, byRule, numbersHold, bounds };
