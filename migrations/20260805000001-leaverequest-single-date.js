'use strict';
//
// Realign leaverequests with the shape the routes and the HR page have
// always used: ONE date plus a shift, not a date range.
//
// The model declared startDate/endDate (both required) plus proofDoc and
// decidedBy/decidedAt/adminRemarks, while every route wrote date,
// documentUrl and reviewedBy/reviewedAt/reviewNotes. Nothing reconciled
// them, so every create failed validation and the module returned 500 —
// meaning almost no rows can exist. This migration is written to be safe
// either way: it only touches documents that still carry the old fields.
//
// 1. date        ← startDate (a range collapses to its first day; the
//                  approval flow only ever syncs attendance per shift on
//                  a single day, so the start is the meaningful one).
// 2. documentUrl ← proofDoc
// 3. reviewedAt  ← decidedAt, reviewNotes ← adminRemarks.
//    decidedBy was a free-text String while reviewedBy is a User
//    ObjectId, so it is NOT copied — an unparseable name would poison the
//    ref. It is preserved under legacyDecidedBy for audit.
// 4. Drops totalDays (range residue; read by nothing).
// 5. Adds the unique (employee, date, shift) index the duplicate-guard in
//    the routes already assumes — after checking for existing duplicates
//    and ABORTING with a report rather than picking a winner itself.
//
// Down: reverses the renames. The dropped index and totalDays are not
// restored (totalDays defaulted to 1 and nothing consumed it).

module.exports = {
  async up(db) {
    const col = db.collection('leaverequests');

    // ── 1. Rename the period + decision fields ───────────────────────
    const renamed = await col.updateMany(
      { startDate: { $exists: true } },
      { $rename: { startDate: 'date' } }
    );
    await col.updateMany({ proofDoc:     { $exists: true } }, { $rename: { proofDoc: 'documentUrl' } });
    await col.updateMany({ decidedAt:    { $exists: true } }, { $rename: { decidedAt: 'reviewedAt' } });
    await col.updateMany({ adminRemarks: { $exists: true } }, { $rename: { adminRemarks: 'reviewNotes' } });
    await col.updateMany({ decidedBy:    { $exists: true } }, { $rename: { decidedBy: 'legacyDecidedBy' } });

    // endDate is dropped, not kept: with a single-date model it has no
    // meaning, and leaving it would re-create the same ambiguity.
    await col.updateMany({}, { $unset: { endDate: '', totalDays: '' } });

    // ── 2. Refuse to proceed if the new unique key already collides ──
    const dupes = await col.aggregate([
      { $match: { date: { $exists: true } } },
      { $group: { _id: { employee: '$employee', date: '$date', shift: '$shift' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } },
    ]).toArray();

    if (dupes.length > 0) {
      const report = dupes
        .map((d) => `  employee=${d._id.employee} date=${d._id.date?.toISOString?.() ?? d._id.date} shift=${d._id.shift} → ${d.ids.length} rows (${d.ids.join(', ')})`)
        .join('\n');
      throw new Error(
        `Refusing to add the unique (employee, date, shift) index — duplicate leave requests exist:\n${report}\n` +
        `Deciding which of a worker's duplicate requests survives is a human call, not a migration side-effect. ` +
        `Resolve these rows, then re-run.`
      );
    }

    await col.createIndex({ employee: 1, date: 1, shift: 1 }, { unique: true, name: 'employee_date_shift_unique' });
    await col.createIndex({ date: 1 }, { name: 'date_1' });

    console.log(`[leaverequest-single-date] renamed ${renamed.modifiedCount} row(s) from startDate → date; unique index created`);
  },

  async down(db) {
    const col = db.collection('leaverequests');
    await col.dropIndex('employee_date_shift_unique').catch(() => {});
    await col.dropIndex('date_1').catch(() => {});
    await col.updateMany({ date:            { $exists: true } }, { $rename: { date: 'startDate' } });
    await col.updateMany({ documentUrl:     { $exists: true } }, { $rename: { documentUrl: 'proofDoc' } });
    await col.updateMany({ reviewedAt:      { $exists: true } }, { $rename: { reviewedAt: 'decidedAt' } });
    await col.updateMany({ reviewNotes:     { $exists: true } }, { $rename: { reviewNotes: 'adminRemarks' } });
    await col.updateMany({ legacyDecidedBy: { $exists: true } }, { $rename: { legacyDecidedBy: 'decidedBy' } });
    // endDate cannot be recovered; mirror startDate so the old required
    // validator is at least satisfiable.
    await col.updateMany({ startDate: { $exists: true }, endDate: { $exists: false } },
      [{ $set: { endDate: '$startDate' } }]);
  },
};
