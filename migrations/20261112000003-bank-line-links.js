'use strict';
//
// Give every voucher that answers a bank line that line's identity.
//
// A line on a bank statement is answered by one entry in the books, and
// an entry answers one line. That is now kept on the entry itself: a
// receipt or payment carries `bankLine`, a contra `bankLineFrom` /
// `bankLineTo`, each "<account>|<line key>#<n>" under a unique index
// (services/bankLines.js). Before this, nothing tied the two together
// but the line's own note of which voucher it became, so the same bank
// line on a second statement could be posted again, and one voucher
// could be matched to two lines.
//
// This reads the statements already stored:
//
//   1. every line is given its occurrence: which of the lines with the
//      same key it is on its statement, in the bank's order;
//   2. every line that is in the books (posted or recorded) with a live
//      voucher gives that voucher its identity — the first line to name
//      a voucher, oldest statement first, has it.
//
//   3. a line whose voucher has since been cancelled goes back to be
//      placed (a cancelled voucher answers nothing; cancelling one now
//      does this by itself), and a cancelled voucher that was posted
//      from a statement gives up its request id, so the line can be
//      posted afresh.
//
// A voucher two different lines both claim, or a line whose voucher
// already answers another line, is left as it is and listed in
// `migration_notes` under this migration's name: that is damage from
// the old behaviour for a person to look at (scripts/accounts-audit-
// check.js lists it too), not something to guess at here.
//
// `down` takes the identities off again. Safe to run twice.

const ME = '20261112000003-bank-line-links';
const NOTES = 'migration_notes';

const lineId = (account, key, n) => `${String(account)}|${key}#${n || 1}`;

module.exports = {
  async up(db) {
    const statements = db.collection('bankstatements');
    const payments = db.collection('payments');
    const contras = db.collection('contras');
    const conflicts = [];
    let linked = 0;
    let freed = 0;
    const free = async (st, l, no) => {
      await statements.updateOne({ _id: st._id }, { $set: { 'lines.$[l].status': 'unmatched', 'lines.$[l].voucher': null, 'lines.$[l].voucherType': null, 'lines.$[l].voucherNo': '', 'lines.$[l].suggestion': null, 'lines.$[l].note': `${no || 'Its voucher'} was cancelled: to be placed again` } }, { arrayFilters: [{ 'l.index': l.index }] });
      freed += 1;
    };
    // The unique indexes are built by the app, which may start after
    // this has run: so this asks for itself whether a line is taken.
    const takenBy = async (id) => {
      const p = await payments.findOne({ bankLine: id }, { projection: { voucherNo: 1 } });
      if (p) return p.voucherNo || String(p._id);
      const c = await contras.findOne({ $or: [{ bankLineFrom: id }, { bankLineTo: id }] }, { projection: { contraNo: 1 } });
      return c ? c.contraNo || String(c._id) : null;
    };

    const cursor = statements.find({}).sort({ createdAt: 1 }).project({ account: 1, file: 1, lines: 1 });
    for await (const st of cursor) {
      const lines = [...(st.lines || [])].sort((a, b) => a.index - b.index);
      // 1. occurrences
      const count = new Map();
      const nth = new Map();
      let missing = false;
      for (const l of lines) {
        const n = (count.get(l.key) || 0) + 1;
        count.set(l.key, Math.max(n, l.occurrence || 0));
        nth.set(l.index, l.occurrence || n);
        if (!l.occurrence) missing = true;
      }
      if (missing) {
        const ops = lines.filter((l) => !l.occurrence).map((l) => ({
          updateOne: { filter: { _id: st._id }, update: { $set: { 'lines.$[l].occurrence': nth.get(l.index) } }, arrayFilters: [{ 'l.index': l.index }] },
        }));
        for (let i = 0; i < ops.length; i += 500) await statements.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      }
      // 2. the voucher of each line that is in the books
      for (const l of lines) {
        if (!['posted', 'recorded'].includes(l.status) || !l.voucher) continue;
        const id = lineId(st.account, l.key, nth.get(l.index));
        const where = { statement: st._id, file: st.file || '', index: l.index, voucherNo: l.voucherNo || '', line: id };
        try {
          if (l.voucherType === 'Contra') {
            const c = await contras.findOne({ _id: l.voucher }, { projection: { from: 1, to: 1, status: 1, bankLineFrom: 1, bankLineTo: 1 } });
            if (c && c.status === 'cancelled') { await free(st, l, l.voucherNo); continue; }
            if (!c || c.status !== 'posted') continue;
            const field = String(c.to) === String(st.account) ? 'bankLineTo' : String(c.from) === String(st.account) ? 'bankLineFrom' : null;
            if (!field) { conflicts.push({ ...where, why: 'the contra is not on this account' }); continue; }
            if (c[field] === id) continue;
            if (c[field]) { conflicts.push({ ...where, why: `the contra already answers another line (${c[field]})` }); continue; }
            const other = await takenBy(id);
            if (other) { conflicts.push({ ...where, why: `${other} already answers this line` }); continue; }
            await contras.updateOne({ _id: c._id, [field]: { $in: [null, ''] } }, { $set: { [field]: id } });
            linked += 1;
          } else {
            const p = await payments.findOne({ _id: l.voucher }, { projection: { account: 1, status: 1, bankLine: 1, source: 1 } });
            if (p && p.status === 'cancelled') {
              await free(st, l, l.voucherNo);
              if (p.source === 'statement') await payments.updateOne({ _id: p._id, status: 'cancelled' }, { $unset: { requestId: '' } });
              continue;
            }
            if (!p || p.status !== 'posted') continue;
            if (p.bankLine === id) continue;
            if (p.bankLine) { conflicts.push({ ...where, why: `the voucher already answers another line (${p.bankLine})` }); continue; }
            const other = await takenBy(id);
            if (other) { conflicts.push({ ...where, why: `${other} already answers this line` }); continue; }
            await payments.updateOne({ _id: p._id, bankLine: { $in: [null, ''] } }, { $set: { bankLine: id } });
            linked += 1;
          }
        } catch (err) {
          if (err && err.code === 11000) { conflicts.push({ ...where, why: 'another voucher already answers this line' }); continue; }
          throw err;
        }
      }
    }
    await db.collection(NOTES).updateOne(
      { _id: ME },
      { $set: { at: new Date(), what: 'Vouchers given the identity of the bank line they answer', linked, freed, conflicts } },
      { upsert: true }
    );
  },

  async down(db) {
    await db.collection('payments').updateMany({ bankLine: { $exists: true } }, { $unset: { bankLine: '' } });
    await db.collection('contras').updateMany({ $or: [{ bankLineFrom: { $exists: true } }, { bankLineTo: { $exists: true } }] }, { $unset: { bankLineFrom: '', bankLineTo: '' } });
    await db.collection(NOTES).deleteOne({ _id: ME });
  },
};
