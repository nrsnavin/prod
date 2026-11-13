'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE WEEK'S PAYMENT RUN — whom to pay, in what order, and why
//
//  propose({ horizon, cushion, useReceipts, budget, account })
//    Every open supplier bill, approved supplier expense and opening
//    balance due by `horizon` days from today, in the order to pay it:
//      1. msme     a micro or small enterprise whose days under the MSMED
//                  Act (agreed, at most 45; else 15) run out by then —
//                  paid later, interest runs at three times the bank rate
//                  and, unpaid at the year end, the bill is not an
//                  expense of the year (s.43B(h))
//      2. overdue  past its due date, the oldest first
//      3. due      falling due by then, the soonest first
//    Each with the TDS its bill carries taken off (the same arithmetic a
//    payment posts with) and a sentence saying why it is in the run.
//    The run spends what is in the bank accounts, less what the cash
//    forecast says goes out by then for other things (salaries, TDS,
//    GST, recurring and approved expenses), less what is to be kept
//    back; receipts expected by then only when asked; or a budget the
//    person names. Bills are taken in order while the money lasts. While
//    a micro or small supplier's bill is left unpaid for want of money,
//    nothing else is proposed: the law puts them first.
//    A supplier whose bank account changed in the last 30 days, shares
//    an account with another supplier, has no bank account on file or
//    is marked inactive is held back, with the reason; the first two can
//    still be paid once someone says how they confirmed it, as a payment
//    always could.
//    Nothing is saved: the proposal is worked out afresh each time.
//
//  pay({ requestId, account, suppliers, riskNotes, ... }, req)
//    The suppliers a person ticked are paid, each by one bank payment
//    settling that supplier's bills in the run, through the same door a
//    typed payment goes (api/accountsCommon.createVoucher: the books
//    lock, the risk checks, the TDS). The run is kept (models/
//    PaymentRun.js) with why each was paid and what each payment made.
//    A request sent twice pays nobody twice.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const BankAccount = require('../models/BankAccount');
const PaymentRun = require('../models/PaymentRun');
const outstanding = require('./outstanding');
const msme = require('./msme');
const credits = require('./credits');
const bankBalances = require('./bankBalances');
const { taxOn } = require('./allocation');
const cal = require('../utils/bizDates');
const { r2 } = require('../utils/money');

const DAY = 86_400_000;
const BANK_CHANGE_DAYS = 30;
const PRIORITY = { msme: 0, overdue: 1, due: 2 };
const isId = (v) => mongoose.isValidObjectId(String(v || ''));
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
/** "18 Nov": the books' days are India days kept at UTC midnight. */
const dm = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const last4 = (no) => (no ? `…${String(no).slice(-4)}` : '');

function msmeWhy(m) {
  const who = m.category === 'micro' ? 'Micro enterprise' : 'Small enterprise';
  const when = m.daysLeft < 0 ? `ran out ${plural(-m.daysLeft, 'day')} ago (${dm(m.dueDate)})` : m.daysLeft === 0 ? 'run out today' : `run out on ${dm(m.dueDate)}`;
  return `${who}: its ${m.days} days under the MSMED Act ${when}. Paid later, interest runs at three times the bank rate, and unpaid at 31 March the bill is not an expense of the year`;
}

/** Why a supplier is held back, if they are. → [{ code, severity, message }] */
function holdsFor(s, shared) {
  const out = [];
  if (!s) return [{ code: 'MISSING', severity: 'danger', message: 'Not on file any more' }];
  if (s.isActive === false) out.push({ code: 'INACTIVE', severity: 'danger', message: `${s.name} is marked inactive` });
  if (!s.bank?.accountNo || !s.bank?.ifsc) out.push({ code: 'NO_BANK', severity: 'danger', message: 'No bank account on file: pay them by cheque from the payment form, or add their account' });
  if (s.bank?.changedAt && Date.now() - new Date(s.bank.changedAt).getTime() < BANK_CHANGE_DAYS * DAY) {
    out.push({ code: 'BANK_CHANGED', severity: 'confirm', message: `Their bank account changed on ${dm(s.bank.changedAt)}${s.bank.changedByName ? ` (by ${s.bank.changedByName})` : ''}, from ${last4(s.bank.previousAccountNo)} to ${last4(s.bank.accountNo)}: call them on the number on file before paying` });
  }
  const twin = s.bank?.accountNo ? shared.get(s.bank.accountNo) : null;
  if (twin) {
    const others = twin.filter((n) => n !== s.name);
    if (others.length) out.push({ code: 'SHARED_ACCOUNT', severity: 'confirm', message: `Their bank account (${last4(s.bank.accountNo)}) is also on file for ${others.join(', ')}` });
  }
  return out;
}

/**
 * The cash the run may spend: the bank accounts, less what goes out by
 * `until` for other things, less the cushion, plus receipts if asked.
 */
async function cashFor({ today, until, payables, cushion, useReceipts, budget, account, horizon }) {
  const accounts = await BankAccount.find({ active: true, kind: 'bank' }).lean();
  const balances = await bankBalances.withBalances(accounts);
  const bank = r2(balances.reduce((t, a) => t + a.balance, 0));
  const payFrom = (isId(account) && balances.find((a) => String(a._id) === String(account))) || balances.find((a) => a.isDefault) || balances[0] || null;
  const end = until.getTime() + DAY - 1;
  let items = [];
  let forecastError = '';
  try {
    const fc = await require('./accountsInsights').forecast({ weeks: Math.ceil(horizon / 7) + 1, now: today });
    items = fc.weeks.flatMap((w) => w.items || []).filter((x) => { const t = new Date(x.date).getTime(); return t >= today.getTime() && t <= end; });
  } catch (err) {
    forecastError = 'The cash forecast could not be worked out: other payments due this week are not set aside';
  }
  // The run's own bills are what it decides; everything else going out is a commitment.
  const ours = new Set(payables.map((r) => r.docNo));
  const commitments = items.filter((x) => x.direction === 'out' && !ours.has(x.docNo))
    .map((x) => ({ party: x.party, docNo: x.docNo, amount: r2(x.amount), date: x.date, basis: x.basis }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const committed = r2(commitments.reduce((t, x) => t + x.amount, 0));
  const receipts = r2(items.filter((x) => x.direction === 'in').reduce((t, x) => t + x.amount, 0));
  const spendable = r2(bank - committed - cushion + (useReceipts ? receipts : 0));
  const named = budget !== null && budget !== undefined && budget !== '' && Number(budget) >= 0;
  return {
    bank, accounts: balances.map((a) => ({ _id: String(a._id), name: a.name, balance: a.balance, isDefault: !!a.isDefault })),
    payFrom: payFrom ? { _id: String(payFrom._id), name: payFrom.name, balance: payFrom.balance } : null,
    commitments, committed, receipts, useReceipts: !!useReceipts, cushion: r2(cushion),
    spendable, budget: named ? r2(Number(budget)) : null, limit: named ? r2(Number(budget)) : Math.max(0, spendable),
    forecastError,
  };
}

/** Docs grouped per supplier, in the order of each supplier's first doc. */
function bySupplier(docs, suppliers, extra = () => ({})) {
  const map = new Map();
  for (const d of docs) {
    const k = String(d.party);
    const s = suppliers.get(k);
    const g = map.get(k) || { supplier: k, supplierName: s?.name || d.partyName, msme: msme.isMsme(s) ? s.msme.category : null, priority: d.priority, why: d.why, docs: [], gross: 0, tds: 0, cash: 0, ...extra(k) };
    g.docs.push(d);
    g.gross = r2(g.gross + d.outstanding);
    g.tds = r2(g.tds + d.tds);
    g.cash = r2(g.cash + d.cash);
    map.set(k, g);
  }
  return [...map.values()];
}

async function propose({ horizon = 7, cushion = 0, useReceipts = false, budget = null, account = null } = {}) {
  const days = Math.min(31, Math.max(1, Math.round(Number(horizon) || 7)));
  const keep = Math.max(0, Number(cushion) || 0);
  const today = cal.today();
  const until = new Date(today.getTime() + days * DAY);
  const [payables, msmeDues, supplierCredits] = await Promise.all([
    outstanding.payables({ asOf: today }),
    msme.dues({ asOf: today }),
    credits.byParty('supplier'),
  ]);
  const rows = payables.filter((r) => r.party);
  const cash = await cashFor({ today, until, payables: rows, cushion: keep, useReceipts, budget, account, horizon: days });

  const ids = [...new Set(rows.map((r) => String(r.party)))];
  const supplierDocs = await Supplier.find({ _id: { $in: ids } }).select('name bank msme isActive').lean();
  const suppliers = new Map(supplierDocs.map((s) => [String(s._id), s]));
  const accountNos = supplierDocs.map((s) => s.bank?.accountNo).filter(Boolean);
  const sharing = accountNos.length ? await Supplier.aggregate([
    { $match: { 'bank.accountNo': { $in: accountNos }, isActive: { $ne: false } } },
    { $group: { _id: '$bank.accountNo', names: { $addToSet: '$name' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]) : [];
  const shared = new Map(sharing.map((x) => [x._id, x.names]));
  const holds = new Map(ids.map((k) => [k, holdsFor(suppliers.get(k), shared)]));

  // Each document: why it is in the run, or that it is not due yet.
  const msmeBy = new Map(msmeDues.rows.map((m) => [String(m.id), m]));
  const docs = [];
  const later = [];
  const end = until.getTime() + DAY - 1;
  for (const r of rows) {
    const m = msmeBy.get(String(r.id));
    const due = new Date(r.dueDate).getTime();
    let priority;
    let why;
    let rank;
    if (m && m.daysLeft <= days) { priority = 'msme'; why = msmeWhy(m); rank = m.daysLeft; }
    else if (due < today.getTime()) { priority = 'overdue'; why = `Due on ${dm(r.dueDate)}: ${plural(r.overdueDays, 'day')} overdue`; rank = -r.overdueDays; }
    else if (due <= end) { priority = 'due'; why = `Due on ${dm(r.dueDate)}`; rank = due; }
    else { later.push(r); continue; }
    const t = taxOn({ kind: 'payment', docType: r.docType, gross: r.outstanding, docTds: r.tds ? { applicable: true, rate: r.tds.rate, section: r.tds.section } : null, ratio: r.taxableRatio ?? 1 });
    docs.push({
      docType: r.docType, id: String(r.id), docNo: r.docNo, refNo: r.refNo || '', date: r.date, dueDate: r.dueDate, party: String(r.party), partyName: r.partyName,
      outstanding: r.outstanding, tds: t.tds, section: t.section, cash: r2(r.outstanding - t.tds), priority, why, rank,
    });
  }
  docs.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.rank - b.rank || new Date(a.date) - new Date(b.date));

  // Taken in order while the money lasts; a micro or small supplier first.
  let left = cash.limit;
  const taken = [];
  const held = [];
  const short = [];
  let msmeLeftOut = 0;
  for (const d of docs) {
    if (holds.get(d.party).length) { held.push(d); continue; }
    if (d.priority !== 'msme' && msmeLeftOut > 0) { short.push({ ...d, reason: 'msme' }); continue; }
    if (d.cash <= left + 0.005) { taken.push(d); left = r2(left - d.cash); continue; }
    if (d.priority === 'msme') msmeLeftOut = r2(msmeLeftOut + d.cash);
    short.push({ ...d, reason: 'cash' });
  }

  const note = (k) => {
    const c = supplierCredits.get(k);
    return c && c.available > 0.005 ? [`They have ${rupees(c.available)} on account (${plural(c.count, 'advance or note', 'advances or notes')}): set it against their bills first, and pay less`] : [];
  };
  const lines = bySupplier(taken, suppliers, (k) => ({ notes: note(k) }));
  const heldLines = bySupplier(held, suppliers, (k) => ({ holds: holds.get(k), notes: note(k) }));
  const shortLines = bySupplier(short, suppliers, (k) => ({ notes: note(k) }));
  const sum = (xs, f) => r2(xs.reduce((t, x) => t + x[f], 0));
  const totals = { suppliers: lines.length, docs: taken.length, gross: sum(lines, 'gross'), tds: sum(lines, 'tds'), cash: sum(lines, 'cash') };
  return {
    asOf: today, horizon: days, until,
    cash: { ...cash, proposed: totals.cash, left: r2(cash.limit - totals.cash) },
    lines, held: heldLines, short: shortLines,
    msmeShort: msmeLeftOut > 0 ? r2(msmeLeftOut - Math.max(0, left)) : 0,
    later: { count: later.length, amount: r2(later.reduce((t, r) => t + r.outstanding, 0)) },
    totals,
  };
}

/**
 * Pay the suppliers ticked. body: { requestId, account, date?, suppliers: [id],
 * riskNotes?: { [id]: note }, horizon?, cushion?, useReceipts?, budget? }
 * → { run, replay }
 */
async function pay(b, req) {
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  const requestId = String(b?.requestId || '').trim().slice(0, 80);
  if (!requestId) throw fail('requestId is required');
  const before = await PaymentRun.findOne({ requestId }).lean();
  if (before) return { run: before, replay: true };
  if (!isId(b.account)) throw fail('Pick the bank account to pay from');
  const account = await BankAccount.findById(b.account).lean();
  if (!account || !account.active) throw fail('Bank account not found', 404);
  if (account.kind !== 'bank') throw fail(`${account.name} is not a bank account: a payment run is paid from the bank`);
  const chosen = [...new Set((Array.isArray(b.suppliers) ? b.suppliers : []).filter(isId).map(String))];
  if (!chosen.length) throw fail('Tick at least one supplier to pay');

  const p = await propose({ horizon: b.horizon, cushion: b.cushion, useReceipts: b.useReceipts, budget: b.budget, account: b.account });
  const pool = new Map();
  for (const l of [...p.short, ...p.held, ...p.lines]) pool.set(l.supplier, l);   // the proposal's own line wins
  let run;
  try {
    run = await PaymentRun.create({ requestId, date: p.asOf, account: account._id, accountName: account.name, cash: p.cash, lines: [], status: 'running', createdBy: req.user?._id || null, createdByName: req.user?.name || '' });
  } catch (err) {
    if (err?.code === 11000) return { run: await PaymentRun.findOne({ requestId }).lean(), replay: true };
    throw err;
  }

  const { createVoucher } = require('../api/accountsCommon');
  const date = (b.date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : p.asOf.toISOString().slice(0, 10));
  const out = [];
  for (const id of chosen) {
    const l = pool.get(id);
    const docsOf = (x) => x.docs.map((d) => ({ docType: d.docType, doc: d.id, docNo: d.docNo, outstanding: d.outstanding, tds: d.tds, cash: d.cash, why: d.why }));
    if (!l) { out.push({ supplier: id, supplierName: '', status: 'failed', error: 'Nothing of theirs is due in this run any more', docs: [], gross: 0, tds: 0, cash: 0 }); continue; }
    const base = { supplier: id, supplierName: l.supplierName, priority: l.priority, why: l.why, docs: docsOf(l), gross: l.gross, tds: l.tds, cash: l.cash };
    const blocking = (l.holds || []).find((h) => h.severity === 'danger');
    if (blocking) { out.push({ ...base, status: 'failed', error: blocking.message }); continue; }
    const riskNote = String(b.riskNotes?.[id] || '').trim().slice(0, 300);
    try {
      const { voucher } = await createVoucher({
        kind: 'payment', partyType: 'supplier', supplier: id, date, account: String(account._id), mode: 'bank', amount: l.cash,
        allocations: l.docs.map((d) => ({ docType: d.docType, doc: d.id, amount: d.outstanding })),
        narration: `Payment run of ${dm(p.asOf)}: ${l.why}`.slice(0, 300),
        requestId: `${requestId}:${id}`,
        ...(riskNote ? { confirmRisk: true, riskNote } : {}),
      }, req);
      out.push({ ...base, riskNote, status: 'paid', payment: voucher._id, voucherNo: voucher.voucherNo });
    } catch (err) {
      out.push({ ...base, riskNote, status: 'failed', error: String(err?.message || 'The payment was refused').slice(0, 400) });
    }
  }
  const paid = out.filter((x) => x.status === 'paid');
  const totals = { suppliers: out.length, paid: paid.length, failed: out.length - paid.length, cash: r2(paid.reduce((t, x) => t + x.cash, 0)), tds: r2(paid.reduce((t, x) => t + x.tds, 0)) };
  const status = !paid.length ? 'failed' : paid.length === out.length ? 'paid' : 'partly_paid';
  const saved = await PaymentRun.findByIdAndUpdate(run._id, { $set: { lines: out, totals, status } }, { new: true }).lean();
  return { run: saved, replay: false };
}

/** The runs paid lately, newest first. */
async function recent(limit = 10) {
  return PaymentRun.find({}).sort({ createdAt: -1 }).limit(Math.min(50, Math.max(1, limit))).lean();
}

module.exports = { propose, pay, recent, holdsFor, msmeWhy };
