'use strict';
// Drafting recurring expenses on their day (models/RecurringExpense.js).

const mongoose = require('mongoose');
const cal = require('../utils/bizDates');
const RecurringExpense = require('../models/RecurringExpense');
const Expense = require('../models/Expense');
const ExpenseCategory = require('../models/ExpenseCategory');
const Supplier = require('../models/Supplier');
const { allocate } = require('./docNumbers');
const { computeInvoice, stateCodeFromGstin } = require('./gst');
const { getDocumentSettings } = require('./documentSettings');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');

/** The date `every` months after `d`, on `day`. */
function advance(d, every, day) {
  // On the books' calendar: the day `d` falls on in India, `every` months on, as that day's UTC midnight.
  const x = cal.parts(d);
  return cal.at(x.y, x.m + every, Math.min(28, day || x.d));
}

/** Upcoming dates for one template up to `until` (for the forecast). */
function occurrences(t, until) {
  const out = [];
  let d = new Date(t.nextDate);
  while (d <= until && (!t.endDate || d <= new Date(t.endDate)) && out.length < 60) {
    out.push(d);
    d = advance(d, t.every, t.dayOfMonth);
  }
  return out;
}

/**
 * Draft every template due on or before `asOf`. Each draft is a pending
 * expense; returns the expense numbers drafted.
 */
async function runDue(asOf = new Date()) {
  const due = await RecurringExpense.find({ active: true, nextDate: { $lte: asOf } }).lean();
  const drafted = [];
  for (const t of due) {
    if (t.endDate && new Date(t.nextDate) > new Date(t.endDate)) {
      await RecurringExpense.updateOne({ _id: t._id }, { $set: { active: false } });
      continue;
    }
    const next = advance(t.nextDate, t.every, t.dayOfMonth);
    // Claim this occurrence: only one caller moves the date on.
    const claimed = await RecurringExpense.updateOne({ _id: t._id, nextDate: t.nextDate, active: true }, { $set: { nextDate: next } });
    if (!claimed.modifiedCount) continue;
    try {
      const category = await ExpenseCategory.findById(t.category).lean();
      const supplier = t.supplier ? await Supplier.findById(t.supplier).lean() : null;
      const settings = await getDocumentSettings();
      const seller = settings.invoice?.stateCode || stateCodeFromGstin(settings.gstin);
      const p = computeInvoice([{ description: t.description, quantity: 1, rate: t.amount, gstPercent: t.gstPercent || 0, hsn: '', unit: '' }], { sellerStateCode: seller, buyerStateCode: stateCodeFromGstin(supplier?.gstin) || seller });
      const { financialYear, sequence, number } = await allocate(Expense, 'EXP', { at: t.nextDate });
      const _id = new mongoose.Types.ObjectId();
      const itc = !!category?.itcEligible && p.totals.tax > 0;
      await Expense.create({
        _id, expenseNo: number, financialYear, sequence, date: t.nextDate,
        dueDate: new Date(new Date(t.nextDate).getTime() + (supplier?.paymentTermsDays ?? 0) * 86_400_000),
        category: t.category, categoryName: category?.name || '', description: t.description,
        supplier: supplier?._id, payeeName: t.payeeName || supplier?.name || '', payeeGstin: supplier?.gstin || '',
        supplyType: p.supplyType, lines: p.lines.map((l) => ({ description: l.description, hsn: '', unit: '', quantity: 1, rate: l.rate, taxable: l.taxable, gstPercent: l.gstPercent, cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount })),
        totals: p.totals, itc: { eligible: itc, amount: itc ? p.totals.tax : 0 },
        // A recurring draft always waits for a person to approve it.
        status: 'pending', approval: { required: true }, submittedByName: `Recurring: ${t.name}`, source: 'recurring',
        notes: `Drafted from the recurring expense "${t.name}"`,
        fingerprints: [buildFingerprint(ACTION_CODES.EXPENSE_SUBMITTED, { entityId: _id, meta: { expenseNo: number, recurring: t.name, grand: p.totals.grand } })],
      });
      await RecurringExpense.updateOne({ _id: t._id }, { $set: { lastDrafted: { expense: _id, expenseNo: number, for: t.nextDate } } });
      drafted.push(number);
    } catch (err) {
      // Put the date back so the occurrence is not lost.
      await RecurringExpense.updateOne({ _id: t._id, nextDate: next }, { $set: { nextDate: t.nextDate } });
      console.warn(`[recurring] ${t.name}: ${err.message}`);
    }
  }
  // Anything still due (a template months behind) catches up on the next call.
  return drafted;
}

module.exports = { runDue, occurrences, advance };
