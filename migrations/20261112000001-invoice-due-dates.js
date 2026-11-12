'use strict';
//
// Give every invoice the due date its customer's credit days set.
//
// An invoice falls due its customer's payment terms ("30" days) after
// its date. The query that loaded the customer for a new invoice left
// the payment terms out, so zero days were added and every invoice
// raised in the app fell due on its own date. Ageing, the collections
// list and its reminders, the dashboard's overdue total and overdue
// interest all counted from the invoice date.
//
// The invoice route now reads the terms (api/invoice.js). This corrects
// what was raised before: an invoice that is not cancelled, and whose
// due date is missing or is its own invoice date, falls due the
// customer's credit days later. The customer's terms as they stand
// today are used; the terms on the day of invoicing were never kept.
// An invoice for a customer with no credit days is left as it is.
//
// What was changed is kept in `migration_notes` under this migration's
// name, with each invoice's old due date, so `down` can put it back.
// `down` restores only an invoice whose due date is still the one set
// here. Safe to run twice: the second run finds nothing to correct.

const ME = '20261112000001-invoice-due-dates';
const NOTES = 'migration_notes';
const DAY = 86_400_000;

/** A customer's credit days from their paymentTerms, as the app reads them. */
function daysOf(terms) {
  const n = parseInt(terms, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0;
}

module.exports = {
  async up(db) {
    const invoices = await db.collection('invoices').find({
      status: { $ne: 'cancelled' },
      invoiceDate: { $type: 'date' },
      $or: [{ dueDate: null }, { dueDate: { $exists: false } }, { $expr: { $eq: ['$dueDate', '$invoiceDate'] } }],
    }).project({ customer: 1, invoiceDate: 1, dueDate: 1, invoiceNumber: 1 }).toArray();
    if (!invoices.length) return;

    const customers = await db.collection('customers').find({ _id: { $in: invoices.map((i) => i.customer).filter(Boolean) } }).project({ paymentTerms: 1 }).toArray();
    const terms = new Map(customers.map((c) => [String(c._id), daysOf(c.paymentTerms)]));

    const ops = [];
    const changed = [];
    for (const inv of invoices) {
      const days = terms.get(String(inv.customer)) || 0;
      if (!days) continue;
      const to = new Date(new Date(inv.invoiceDate).getTime() + days * DAY);
      ops.push({ updateOne: { filter: { _id: inv._id }, update: { $set: { dueDate: to } } } });
      changed.push({ invoice: inv._id, invoiceNumber: inv.invoiceNumber || '', from: inv.dueDate || null, to, days });
    }
    for (let i = 0; i < ops.length; i += 500) await db.collection('invoices').bulkWrite(ops.slice(i, i + 500), { ordered: false });
    if (changed.length) {
      await db.collection(NOTES).updateOne(
        { _id: ME },
        { $setOnInsert: { at: new Date(), what: 'Invoices given the due date their customer\'s credit days set' }, $push: { changed: { $each: changed } } },
        { upsert: true }
      );
    }
  },

  async down(db) {
    const note = await db.collection(NOTES).findOne({ _id: ME });
    if (!note) return;
    const ops = [];
    for (const c of note.changed || []) {
      // Only where the due date is still the one this migration set.
      const filter = { _id: c.invoice, dueDate: c.to };
      ops.push({ updateOne: { filter, update: c.from ? { $set: { dueDate: c.from } } : { $unset: { dueDate: '' } } } });
    }
    for (let i = 0; i < ops.length; i += 500) await db.collection('invoices').bulkWrite(ops.slice(i, i + 500), { ordered: false });
    await db.collection(NOTES).deleteOne({ _id: ME });
  },
};
