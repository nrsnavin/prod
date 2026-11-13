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
//  A bank line is one line however many statements carry it: each has
//  an identity (services/bankLines.js), and a line a live voucher
//  already answers comes in as "in the books" with that voucher. So an
//  overlapping upload does not put last week's placed lines back on
//  the list to be posted a second time.
//
//  An MT940 file names its account; one put into a different account
//  is refused rather than booked to the wrong bank.
// ══════════════════════════════════════════════════════════════════

const BankStatement = require('../models/BankStatement');
const bankStatement = require('./bankStatement');
const bankLines = require('./bankLines');
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
  // Every line's identity, numbered on the whole file as the bank sent
  // it: the account, the line's key, and which of the same-key lines it
  // is (services/bankLines.js).
  const allKeys = parsed.map((r) => bankStatement.lineKey(r));
  const occ = bankLines.occurrences(allKeys);
  parsed.forEach((r, i) => { r.key = allKeys[i]; r.occurrence = occ[i]; r.lineId = bankLines.lineId(account._id, allKeys[i], occ[i]); });
  const earlier = await BankStatement.find({ account: account._id, 'lines.key': { $in: [...new Set(allKeys)] } })
    .select('lines.index lines.key lines.occurrence lines.status lines.note').lean();
  let rows = parsed;
  if (source !== 'upload') {
    // A line the bank sent before is not a new line. Per key: as many as
    // any one earlier statement already holds, so the second of two
    // equal charges is new when only the first was seen.
    const seen = new Map();
    for (const st of earlier) { const nth = bankLines.occurrenceMap(st); for (const l of st.lines) seen.set(l.key, Math.max(seen.get(l.key) || 0, nth.get(l.index))); }
    rows = rows.filter((r) => r.occurrence > (seen.get(r.key) || 0));
    if (!rows.length) return { statement: null, rows: [], counts: {}, closingBalance: bankStatement.closingOf(parsed), newLines: 0, total: parsed.length };
  }
  // A line a live voucher already answers (posted from it, or matched to
  // it, on an earlier statement) is in the books: nothing to ask again.
  const held = await bankLines.vouchersFor(rows.map((r) => r.lineId));
  const fresh = rows.filter((r) => !held.has(r.lineId));
  const placed = fresh.length ? await bankStatement.match(fresh, account._id, { useModel }) : [];
  // A line the matcher found in the books takes that entry for itself.
  // If another line took it in the same moment, this one is left to be
  // placed by a person.
  for (const r of placed) {
    if (r.status !== 'recorded' || !r.recorded) continue;
    const got = await bankLines.claim(r.recorded.voucherType, r.recorded._id, account._id, r.lineId);
    if (got !== 'claimed' && got !== 'same') { r.status = 'unmatched'; r.recorded = null; r.suggestion = null; }
  }
  const byIndex = new Map(placed.map((r) => [r.index, r]));
  const matched = rows.map((r) => byIndex.get(r.index) || { ...r, status: 'recorded', suggestion: null, recorded: held.get(r.lineId) });
  const keys = matched.map((r) => r.key);
  // A line a person set aside before stays set aside: that line, not
  // another of the same amount and words.
  const ignored = new Map();
  for (const st of earlier) { const nth = bankLines.occurrenceMap(st); for (const l of st.lines) if (l.status === 'ignored') ignored.set(bankLines.lineId(account._id, l.key, nth.get(l.index)), l.note); }
  for (const r of matched) {
    if (r.status !== 'recorded' && ignored.has(r.lineId)) { r.status = 'ignored'; r.note = ignored.get(r.lineId); r.suggestion = null; }
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
      index: r.index, date: r.date, narration: r.narration, ref: r.ref, amount: r.amount, direction: r.direction, balance: r.balance ?? null, key: keys[i], occurrence: r.occurrence,
      status: r.status, voucherType: r.recorded?.voucherType || null, voucher: r.recorded?._id || null, voucherNo: r.recorded?.voucherNo || '', note: r.note || '',
      suggestion: r.status === 'matched' ? r.suggestion || null : null, candidates: r.candidates?.length ? r.candidates : null,
    })),
  });
  // What the bank shows is cleared in the books.
  for (const r of matched) if (r.status === 'recorded' && r.recorded) await reconcile.markCleared(r.recorded.voucherType, r.recorded._id, account._id, r.date);
  // A remembered payer a person has posted unchanged often enough: its
  // lines post themselves, when the books allow it (services/learnedPosting.js).
  const learned = await require('./learnedPosting').postLearned(statement._id, account._id, { via: source })
    .catch((err) => { console.warn(`[statement-import] lines posting themselves: ${err.message}`); return { posted: [] }; });
  for (const p of learned.posted) {
    const r = matched.find((x) => x.index === p.index);
    if (r) Object.assign(r, { status: 'posted', voucherNo: p.voucherNo, note: `Posted by itself: lines with "${p.text}" were posted unchanged before` });
  }
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
