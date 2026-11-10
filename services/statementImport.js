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
//  For a statement the bank sends (by mail or SFTP), lines already
//  brought in earlier are left out (the bank's daily statements
//  overlap), and a statement with nothing new is not kept at all.
//
//  An MT940 file names its account; one put into a different account
//  is refused rather than booked to the wrong bank.
// ══════════════════════════════════════════════════════════════════

const BankStatement = require('../models/BankStatement');
const bankStatement = require('./bankStatement');
const reconcile = require('./reconcile');

/**
 * @returns { statement, rows, counts, closingBalance, newLines, total } — statement null when nothing new
 */
const digits = (v) => String(v || '').replace(/\D/g, '');

/** Is the account number the file names this account's? Last digits are enough when one side is shortened. */
function sameAccount(fileNo, account) {
  const a = digits(fileNo);
  const b = digits(account.accountNo);
  if (!a || !b) return true; // nothing to compare
  const n = Math.min(a.length, b.length, 10);
  return n >= 4 && a.slice(-n) === b.slice(-n);
}

async function importStatement({ account, buffer, mimetype, filename = '', rows: given = null, accountNo = '', by = null, byName = '', source = 'upload', messageId = '', useModel = true }) {
  const detail = given ? { rows: given, accountNo } : await bankStatement.parseDetailed(buffer, mimetype, filename);
  const parsed = detail.rows.map((r, index) => ({ ...r, index }));
  if (!parsed.length) { const e = new Error('No transactions found in the file'); e.status = 400; throw e; }
  if (!sameAccount(detail.accountNo, account)) {
    const e = new Error(`This statement is for account ending ${digits(detail.accountNo).slice(-4)}, not ${account.name}`);
    e.status = 400; e.code = 'STATEMENT_ACCOUNT';
    throw e;
  }
  let rows = parsed;
  const allKeys = rows.map((r) => bankStatement.lineKey(r));
  if (source !== 'upload') {
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
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));
  const openingBalance = bankStatement.openingOf(parsed);
  // How this statement sits against the last one for the account: days
  // nobody downloaded, lines already brought in, a balance that does not
  // carry over (lines missing between the two).
  const previous = await BankStatement.findOne({ account: account._id }).sort({ to: -1, createdAt: -1 }).select('file from to closingBalance').lean();
  const seenBefore = new Set();
  for (const st of earlier) for (const l of st.lines) seenBefore.add(l.key);
  const continuity = continuityOf({ previous, from, to, openingBalance, overlapLines: keys.filter((k) => seenBefore.has(k)).length });
  const statement = await BankStatement.create({
    account: account._id, accountName: account.name, file: filename || '',
    from, to, openingBalance, closingBalance: bankStatement.closingOf(parsed),
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
  return { statement, rows: matched, counts, closingBalance: statement.closingBalance, newLines: matched.length, total: parsed.length, continuity };
}

const DAY = 86_400_000;
const { r2 } = require('../utils/money');
const dayOf = (d) => { const x = new Date(d); return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()); };

/**
 * @returns { previous: { file, from, to, closingBalance } | null, from, to,
 *   openingBalance, gapDays, overlapLines, balanceDiff }
 * gapDays: whole days between the last statement's end and this one's
 * start that neither covers. balanceDiff: this file's opening balance
 * less the last one's closing, when this one starts after it ends and
 * both carry balances — not zero means lines are missing between them
 * (a gap with no difference is days without a transaction).
 */
function continuityOf({ previous, from, to, openingBalance, overlapLines }) {
  const prev = previous ? { file: previous.file || '', from: previous.from, to: previous.to, closingBalance: previous.closingBalance ?? null } : null;
  let gapDays = 0;
  let balanceDiff = null;
  if (prev?.to) {
    const days = Math.round((dayOf(from) - dayOf(prev.to)) / DAY);
    gapDays = Math.max(0, days - 1);
    if (days >= 1 && prev.closingBalance !== null && openingBalance !== null && openingBalance !== undefined) {
      const diff = r2(openingBalance - prev.closingBalance);
      balanceDiff = Math.abs(diff) > 0.005 ? diff : 0;
    }
  }
  return { previous: prev, from, to, openingBalance: openingBalance ?? null, gapDays, overlapLines, balanceDiff };
}

module.exports = { importStatement, sameAccount, continuityOf };
