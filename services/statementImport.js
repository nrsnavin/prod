'use strict';
// ══════════════════════════════════════════════════════════════════
//  A BANK STATEMENT INTO THE BOOKS — HOWEVER IT ARRIVED
//
//  One path for a statement a person uploads and one the bank emails:
//  read the file, place each line (already in the books, a document in
//  the narration, the party's name, one exact amount, or left for a
//  person), keep a line set aside before set aside, mark what the bank
//  shows as cleared, and keep the statement — now with what the matcher
//  proposed for each line, so it can be confirmed and posted later from
//  the stored statement without uploading it again.
//
//  For a mailed statement, lines already brought in by an earlier mail
//  are left out (the bank's daily statements overlap), and a statement
//  with nothing new is not kept at all.
// ══════════════════════════════════════════════════════════════════

const BankStatement = require('../models/BankStatement');
const bankStatement = require('./bankStatement');
const reconcile = require('./reconcile');

/**
 * @returns { statement, rows, counts, closingBalance, newLines, total } — statement null when nothing new
 */
async function importStatement({ account, buffer, mimetype, filename = '', by = null, byName = '', source = 'upload', messageId = '', useModel = true }) {
  const parsed = await bankStatement.parse(buffer, mimetype, filename);
  if (!parsed.length) { const e = new Error('No transactions found in the file'); e.status = 400; throw e; }
  let rows = parsed;
  const allKeys = rows.map((r) => bankStatement.lineKey(r));
  if (source === 'email') {
    // Overlapping daily statements: only lines this account has not seen.
    const seen = new Set();
    for (const st of await BankStatement.find({ account: account._id, 'lines.key': { $in: allKeys } }).select('lines.key').lean()) for (const l of st.lines) seen.add(l.key);
    rows = rows.filter((_, i) => !seen.has(allKeys[i]));
    if (!rows.length) return { statement: null, rows: [], counts: {}, closingBalance: bankStatement.closingOf(parsed), newLines: 0, total: parsed.length };
  }
  const matched = await bankStatement.match(rows, account._id, { useModel });
  // A line set aside in an earlier statement stays set aside.
  const keys = matched.map((r) => bankStatement.lineKey(r));
  const earlier = await BankStatement.find({ account: account._id, 'lines.key': { $in: keys } }).select('lines.key lines.status lines.note').lean();
  const ignored = new Map();
  for (const st of earlier) for (const l of st.lines) if (l.status === 'ignored' && keys.includes(l.key)) ignored.set(l.key, l.note);
  for (const [i, r] of matched.entries()) {
    if (r.status !== 'recorded' && ignored.has(keys[i])) { r.status = 'ignored'; r.note = ignored.get(keys[i]); r.suggestion = null; }
  }
  const dates = rows.map((r) => r.date.getTime());
  const statement = await BankStatement.create({
    account: account._id, accountName: account.name, file: filename || '',
    from: new Date(Math.min(...dates)), to: new Date(Math.max(...dates)), closingBalance: bankStatement.closingOf(parsed),
    uploadedBy: by, uploadedByName: byName, source, messageId,
    lines: matched.map((r, i) => ({
      index: r.index, date: r.date, narration: r.narration, ref: r.ref, amount: r.amount, direction: r.direction, balance: r.balance ?? null, key: keys[i],
      status: r.status, voucherType: r.recorded?.voucherType || null, voucher: r.recorded?._id || null, voucherNo: r.recorded?.voucherNo || '', note: r.note || '',
      suggestion: r.status === 'matched' ? r.suggestion || null : null, candidates: r.candidates?.length ? r.candidates : null,
    })),
  });
  // What the bank shows is cleared in the books.
  for (const r of matched) if (r.status === 'recorded' && r.recorded) await reconcile.markCleared(r.recorded.voucherType, r.recorded._id, account._id, r.date);
  const counts = { recorded: 0, matched: 0, unmatched: 0 };
  for (const r of matched) counts[r.status] = (counts[r.status] || 0) + 1;
  return { statement, rows: matched, counts, closingBalance: statement.closingBalance, newLines: matched.length, total: parsed.length };
}

module.exports = { importStatement };
