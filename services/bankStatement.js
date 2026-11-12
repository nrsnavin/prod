'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANK STATEMENT → VOUCHERS
//
//  parse()  a CSV or Excel statement, whatever the bank calls its
//           columns, or an MT940 file (services/mt940.js), into
//           { date, narration, ref, amount, direction }
//  match()  each line to what the books expect: a voucher already
//           recorded for it, an open invoice or bill it settles (by a
//           document number in the narration, a payer remembered from
//           an earlier statement, the party's name, or an exact amount),
//           and the odd ones left for a person — with
//           one model call, when configured, to put a name to a
//           narration the rules could not.
//
//  Nothing here writes. api/accounts.js posts the lines the person
//  confirms, as ordinary vouchers marked source "statement".
// ══════════════════════════════════════════════════════════════════

const ExcelJS = require('exceljs');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const BankAlias = require('../models/BankAlias');
const BankAccount = require('../models/BankAccount');
const BankStatement = require('../models/BankStatement');
const ExpenseCategory = require('../models/ExpenseCategory');
const statementAi = require('./statementAi');
const outstanding = require('./outstanding');
const bankLines = require('./bankLines');
const mt940 = require('./mt940');

const { r2 } = require('../utils/money');
const DAY = 86_400_000;

// ── Parsing ───────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function sheetRows(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const rows = [];
  if (!ws) return rows;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const v = cell.value;
      cells[col - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === 'object' && 'result' in v ? v.result : v && typeof v === 'object' && 'richText' in v ? v.richText.map((t) => t.text).join('') : v;
    });
    rows.push(cells.map((c) => (c == null ? '' : String(c))));
  });
  return rows;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]); }
  m = s.match(/^(\d{1,2})[ /-]([A-Za-z]{3,4})[ /-](\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(y, MONTHS[m[2].toLowerCase()], +m[1]); }
  return null;
}
const money = (v) => {
  const s = String(v ?? '').replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!s || s === '-') return 0;
  const n = Number(s.replace(/(cr|dr)$/i, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Which column is which, from the header row the bank wrote. */
function columnsOf(header) {
  const h = header.map((x) => String(x || '').trim().toLowerCase());
  const find = (re) => h.findIndex((x) => re.test(x));
  const date = find(/^(txn|transaction|value)?\s*date|^date/);
  const narration = find(/narration|description|particular|remark|detail|transaction\s*(details|description)/);
  const debit = find(/withdraw|debit|\bdr\b/);
  const credit = find(/deposit|credit|\bcr\b/);
  const amount = find(/^amount|^amt|transaction amount/);
  const drcr = find(/dr\s*\/\s*cr|cr\s*\/\s*dr|^type$|debit\/credit/);
  const ref = find(/ref|cheque|chq|utr|instrument/);
  const balance = find(/balance/);
  return { date, narration, debit, credit, amount, drcr, ref, balance };
}

/**
 * @returns rows [{ index, date, narration, ref, amount, direction: 'in'|'out' }]
 */
async function parse(buffer, mimetype, filename = '') {
  return (await parseDetailed(buffer, mimetype, filename)).rows;
}

/**
 * parse(), and what else the file says: its format and, for MT940, the
 * account number the bank wrote in it.
 * @returns { rows, format: 'mt940'|'sheet'|'csv', accountNo }
 */
/**
 * What the file really is, from its first bytes — a bank's ".xls" is as
 * often an HTML table or tab-separated text as a spreadsheet.
 *   xlsx   a zip (Excel 2007 onwards)
 *   xls    an old binary Excel workbook (OLE2) — not readable here
 *   html   a web page holding the statement as a table
 *   text   anything else: CSV, tab-separated, MT940
 */
function sniff(buffer) {
  const b = buffer || Buffer.alloc(0);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'xlsx';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls';
  const head = b.slice(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<') && /<(table|html|tr)\b/.test(head)) return 'html';
  return 'text';
}

/** Rows of the first table that holds a date column, from an HTML page. */
function htmlRows(text) {
  const decode = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
  const rows = [];
  for (const tr of text.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    rows.push((tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []).map(decode));
  }
  return rows;
}

/** A plain-text table: tab-separated when the lines carry tabs, else CSV. */
function textRows(text) {
  const lines = text.split(/\r?\n/).slice(0, 40);
  const tabs = lines.filter((l) => l.includes('\t')).length;
  if (tabs >= 2) return text.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.replace(/^"(.*)"$/, '$1').trim()));
  return parseCsv(text);
}

async function parseDetailed(buffer, mimetype, filename = '') {
  const kind = sniff(buffer);
  if (kind === 'xls') {
    const e = new Error('This is an old-style Excel file (.xls), which cannot be read. Download the statement as CSV from net banking, or open this file in Excel and save it as .xlsx, then upload that.');
    e.code = 'STATEMENT_XLS'; e.status = 400;
    throw e;
  }
  if (kind === 'html') {
    const rows = await parseTable(null, false, htmlRows(buffer.toString('utf8')));
    return { rows, format: 'html', accountNo: '' };
  }
  const isSheet = kind === 'xlsx';
  if (!isSheet) {
    const text = buffer.toString('utf8');
    if (mt940.isMt940(text)) {
      const statements = mt940.parseMt940(text);
      const accounts = [...new Set(statements.map((st) => st.account).filter(Boolean))];
      if (accounts.length > 1) {
        const e = new Error(`This MT940 file holds statements for ${accounts.length} accounts; upload one account's file at a time`);
        e.code = 'STATEMENT_ACCOUNTS'; e.status = 400;
        throw e;
      }
      const rows = statements.flatMap((st) => st.rows).map((r, index) => ({ ...r, index }));
      return { rows, format: 'mt940', accountNo: accounts[0] || '' };
    }
  }
  const rows = await parseTable(buffer, isSheet);
  return { rows, format: isSheet ? 'sheet' : 'csv', accountNo: '' };
}

async function parseTable(buffer, isSheet, given = null) {
  const table = given || (isSheet ? await sheetRows(buffer) : textRows(buffer.toString('utf8').replace(/^﻿/, '')));
  // The header is the first row with a date column and a narration column.
  let headerAt = -1;
  let cols = null;
  for (let i = 0; i < Math.min(table.length, 30); i++) {
    const c = columnsOf(table[i]);
    if (c.date >= 0 && c.narration >= 0 && (c.debit >= 0 || c.credit >= 0 || c.amount >= 0)) { headerAt = i; cols = c; break; }
  }
  if (!cols) {
    const e = new Error('Could not find the statement columns (date, narration, debit / credit). Export the statement as CSV, Excel or MT940 from the bank\'s site.');
    e.code = 'STATEMENT_COLUMNS';
    throw e;
  }
  const rows = [];
  for (let i = headerAt + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || !r.some((x) => String(x || '').trim())) continue;
    const date = parseDate(r[cols.date]);
    if (!date) continue;
    let amount = 0;
    let direction = null;
    if (cols.debit >= 0 || cols.credit >= 0) {
      const dr = cols.debit >= 0 ? money(r[cols.debit]) : 0;
      const cr = cols.credit >= 0 ? money(r[cols.credit]) : 0;
      if (cr > 0) { amount = cr; direction = 'in'; } else if (dr > 0) { amount = dr; direction = 'out'; }
    }
    if (!direction && cols.amount >= 0) {
      const a = money(r[cols.amount]);
      const t = cols.drcr >= 0 ? String(r[cols.drcr] || '').trim().toLowerCase() : '';
      if (a !== 0) { amount = Math.abs(a); direction = t.startsWith('c') || (!t && a > 0) ? 'in' : 'out'; }
    }
    if (!direction || amount <= 0) continue;
    const bal = cols.balance >= 0 && String(r[cols.balance] ?? '').trim() !== '' ? money(r[cols.balance]) : null;
    rows.push({
      index: rows.length, date, narration: String(r[cols.narration] || '').trim().slice(0, 300),
      ref: cols.ref >= 0 ? String(r[cols.ref] || '').trim().slice(0, 60) : '', amount: r2(amount), direction,
      balance: bal === null ? null : r2(bal),
    });
  }
  return rows;
}

/** A line's identity: the same line in two uploads has the same key. */
function lineKey(row) {
  // A statement date is the server's local midnight of that day
  // (parseDate), so it is read back the same way: the key names the
  // right day whatever the server's clock is set to. Not to be changed:
  // the keys of every stored line were made this way, and a line's key
  // is its identity (services/bankLines.js).
  const d = new Date(row.date);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [day, row.direction, r2(row.amount).toFixed(2), String(row.narration || '').toUpperCase().replace(/\s+/g, ' ').trim(), String(row.ref || '').toUpperCase().trim()].join('|');
}

/**
 * The bank's balance before the chronologically first line, when the
 * file has a balance column: that line's balance, less what it brought
 * in or plus what it took out.
 */
function openingOf(rows) {
  if (!rows.length) return null;
  const ascending = new Date(rows[0].date) <= new Date(rows[rows.length - 1].date);
  const first = ascending ? rows[0] : rows[rows.length - 1];
  if (first.balance === null || first.balance === undefined) return null;
  return r2(first.direction === 'in' ? first.balance - first.amount : first.balance + first.amount);
}

/** The bank's balance after the chronologically last line, when the file has one. */
function closingOf(rows) {
  const withBal = rows.filter((r) => r.balance !== null && r.balance !== undefined);
  if (!withBal.length) return null;
  // Statements run oldest-first or newest-first; follow the dates.
  const ascending = new Date(rows[0].date) <= new Date(rows[rows.length - 1].date);
  const last = ascending ? withBal[withBal.length - 1] : withBal[0];
  return last.balance;
}

// ── Matching ──────────────────────────────────────────────────────
const STOP = new Set(['NEFT', 'RTGS', 'IMPS', 'UPI', 'TRANSFER', 'FROM', 'TO', 'PAYMENT', 'PVT', 'LTD', 'LIMITED', 'PRIVATE', 'THE', 'AND', 'BANK', 'CHQ', 'CHEQUE', 'DEPOSIT', 'WITHDRAWAL', 'TXN', 'REF', 'INB', 'MOB', 'BY', 'OF', 'FOR', 'INDIA', 'ENTERPRISES', 'TRADERS', 'TEXTILES', 'GARMENTS', 'EXPORTS', 'INTERNATIONAL', 'CO']);
const tokens = (s) => new Set(String(s || '').toUpperCase().replace(/[^A-Z0-9/ -]/g, ' ').split(/[\s/-]+/).filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));

function nameScore(narration, name) {
  const n = tokens(narration);
  const p = [...tokens(name)];
  if (!p.length) return 0;
  const hit = p.filter((t) => n.has(t)).length;
  return hit / p.length;
}

/** Up to three documents of one party whose outstanding adds to the amount. */
function subsetFor(docs, amount) {
  const near = (x) => Math.abs(x - amount) < 1;
  for (const a of docs) if (near(a.outstanding)) return [a];
  for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) if (near(docs[i].outstanding + docs[j].outstanding)) return [docs[i], docs[j]];
  for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) for (let k = j + 1; k < docs.length; k++) if (near(docs[i].outstanding + docs[j].outstanding + docs[k].outstanding)) return [docs[i], docs[j], docs[k]];
  return null;
}

/** Oldest first, until the amount is used up. */
function fifo(docs, amount) {
  const out = [];
  let left = amount;
  for (const d of [...docs].sort((a, b) => new Date(a.date) - new Date(b.date))) {
    if (left <= 0.005) break;
    const take = r2(Math.min(left, d.outstanding));
    out.push({ doc: d, amount: take });
    left = r2(left - take);
  }
  return out;
}

const alloc = (pairs) => pairs.map(({ doc, amount }) => ({ docType: doc.docType, doc: doc.id, docNo: doc.docNo, amount: r2(amount ?? doc.outstanding) }));

const CASH_OUT = /\b(CASH\s*WDL|CASH\s*WITHDRAWAL|ATM\s*WDL|ATW|NWD|SELF\s*(CHQ|CHEQUE|WDL)|CASH\s*PAID)\b/;
const CASH_IN = /\b(CASH\s*DEP(OSIT)?|BY\s*CASH|CASH\s*RECEIVED|CDM)\b/;

/**
 * A transfer between two of our own accounts, from the narration: the
 * other account's number (its last six digits or more), or cash drawn
 * or paid in at the counter (the cash box on the other side).
 */
function transferOf(row, otherAccounts, cashAccount) {
  const text = String(row.narration || '').toUpperCase();
  // Digit runs as the narration writes them (an account number is one run, or ends one).
  const runs = (`${text} ${String(row.ref || '').toUpperCase()}`).match(/\d{6,}/g) || [];
  for (const a of otherAccounts) {
    const no = String(a.accountNo || '').replace(/\D/g, '');
    if (no.length >= 6 && runs.some((r) => r.endsWith(no.slice(-6)) && (no.endsWith(r) || r.endsWith(no) || r.length <= 8))) {
      return { kind: 'contra', partyType: 'other', party: null, partyName: a.name, account: a._id, accountName: a.name, allocations: [], confidence: 0.85, reason: `account ending ${no.slice(-4)} (${a.name}) in the narration` };
    }
  }
  if (cashAccount && ((row.direction === 'out' && CASH_OUT.test(text)) || (row.direction === 'in' && CASH_IN.test(text)))) {
    return { kind: 'contra', partyType: 'other', party: null, partyName: cashAccount.name, account: cashAccount._id, accountName: cashAccount.name, allocations: [], confidence: 0.8, reason: row.direction === 'out' ? `cash drawn: into ${cashAccount.name}` : `cash paid in: from ${cashAccount.name}` };
  }
  return null;
}

/** `number` stands in `text` as a whole: not inside a longer run of letters or digits. */
function standsAlone(text, number) {
  const n = String(number || '').toUpperCase().trim();
  if (!n) return false;
  for (let from = 0; ;) {
    const i = text.indexOf(n, from);
    if (i < 0) return false;
    const before = i > 0 ? text[i - 1] : ' ';
    const after = i + n.length < text.length ? text[i + n.length] : ' ';
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
    from = i + 1;
  }
}

/**
 * The open documents a narration names, all of one party.
 *
 * Our own number (INV/2026-27/0012) counts wherever it stands as a
 * whole. The party's own number for it (a supplier's bill no., an
 * opening balance's reference) is often short and all digits: four
 * digits sit inside most sixteen-digit bank references. So it counts
 * only standing alone, and then only when it is six characters or
 * more, or the party's name is in the narration too.
 * @returns { docs, via: 'number' | 'their-number', text } or null
 */
function namedIn(text, narration, openDocs) {
  const hits = [];
  for (const d of openDocs) {
    if (standsAlone(text, d.docNo)) { hits.push({ d, via: 'number', text: d.docNo }); continue; }
    const ref = String(d.refNo || '').trim();
    if (ref.length >= 4 && standsAlone(text, ref) && (ref.length >= 6 || nameScore(narration, d.partyName) >= 0.5)) hits.push({ d, via: 'their-number', text: ref });
  }
  if (!hits.length) return null;
  const first = hits[0];
  const same = hits.filter((h) => String(h.d.party) === String(first.d.party));
  return { docs: same.map((h) => h.d), via: first.via, text: same.map((h) => (h.via === 'number' ? h.d.docNo : `${h.text} (${h.d.docNo})`)).join(' + ') };
}

/**
 * What a line that names documents settles. Sure (0.95, `exact`) only
 * when the named documents themselves add up to the amount. Anything
 * else is a guess about the rest and says so, at a confidence that is
 * never posted without a person.
 */
function suggestNamed(named, groups, amount) {
  const first = named.docs[0];
  const group = groups.find((g) => String(g.party) === String(first.party));
  const docs = group?.docs || named.docs;
  const base = { party: first.party, partyName: first.partyName };
  const what = `${named.via === 'number' ? '' : 'their no. '}${named.text} named in the narration`;
  const total = r2(named.docs.reduce((t, d) => t + d.outstanding, 0));
  if (Math.abs(total - amount) < 1) return { ...base, allocations: alloc(named.docs.map((doc) => ({ doc }))), confidence: 0.95, exact: true, reason: what };
  const isNamed = (d) => named.docs.some((n) => String(n.id) === String(d.id));
  const subset = subsetFor(docs, amount);
  if (subset && subset.some(isNamed)) return { ...base, allocations: alloc(subset.map((doc) => ({ doc }))), confidence: 0.9, reason: `${what}; amount matches ${subset.map((d) => d.docNo).join(' + ')}` };
  if (amount < total - 0.005) return { ...base, allocations: alloc(fifo(named.docs, amount)), confidence: 0.85, reason: `${what}, part paid` };
  // More than the named documents: those first, the rest oldest first.
  const rest = fifo(docs.filter((d) => !isNamed(d)), r2(amount - total));
  return { ...base, allocations: alloc([...named.docs.map((doc) => ({ doc })), ...rest]), confidence: 0.8, reason: `${what}; the rest allocated oldest first` };
}

/** How people placed this account's lines before, and what is remembered: the model's best guide. */
async function placedBefore(accountId, aliases) {
  const out = aliases.slice(0, 20).map((a) => `${a.text} → ${a.partyName}${a.headName ? ` (${a.headName})` : a.incomeLedger === 'interest' ? ' (interest)' : ''}`);
  const statements = await BankStatement.find({ account: accountId, 'lines.status': 'posted' }).sort({ createdAt: -1 }).limit(4).select('lines.narration lines.status lines.voucher lines.voucherType').lean();
  const lines = statements.flatMap((s) => s.lines.filter((l) => l.status === 'posted' && l.voucher)).slice(0, 40);
  const vouchers = new Map((await Payment.find({ _id: { $in: lines.filter((l) => l.voucherType !== 'Contra').map((l) => l.voucher) } }).select('partyName partyType headName incomeLedger').lean()).map((v) => [String(v._id), v]));
  for (const l of lines) {
    const v = vouchers.get(String(l.voucher));
    if (!v) continue;
    out.push(`${l.narration.slice(0, 80)} → ${v.partyName}${v.partyType === 'other' ? (v.headName ? ` (${v.headName})` : v.incomeLedger === 'interest' ? ' (interest)' : ' (not on file)') : ` (${v.partyType})`}`);
  }
  return out.slice(0, 40);
}

/**
 * @param rows   from parse()
 * @param accountId  the bank account the statement is for (recorded vouchers are looked up on it)
 */
async function match(rows, accountId, { useModel = true } = {}) {
  const [recv, pay, customers, suppliers, aliases, ownAccounts] = await Promise.all([
    outstanding.receivables(), outstanding.payables(),
    Customer.find({ archived: { $ne: true } }).select('name').lean(), Supplier.find({}).select('name').lean(),
    BankAlias.find({}).lean(),
    BankAccount.find({ active: { $ne: false } }).select('name kind accountNo').lean(),
  ]);
  const rememberedUsed = new Set();
  const thisAccount = ownAccounts.find((a) => String(a._id) === String(accountId));
  const otherAccounts = ownAccounts.filter((a) => String(a._id) !== String(accountId));
  const cashAccount = otherAccounts.find((a) => a.kind === 'cash') || null;
  const recvByParty = outstanding.byParty(recv);
  const payByParty = outstanding.byParty(pay);
  const dates = rows.map((r) => r.date.getTime());
  const window = rows.length ? { $gte: new Date(Math.min(...dates) - 7 * DAY), $lte: new Date(Math.max(...dates) + 7 * DAY) } : null;
  // Entries already in the books that could answer a line: only the ones
  // that answer no bank line yet. One that an earlier line was posted
  // from, or matched to, carries that line (services/bankLines.js) and
  // is left out: a second charge of the same amount a few days later is
  // a second charge, not the first one again.
  const [vouchers, contras] = rows.length ? await Promise.all([
    Payment.find({ status: 'posted', account: accountId, date: window, ...bankLines.free('bankLine') }).select('kind date amount reference voucherNo partyName').lean(),
    Contra.find({ status: 'posted', $or: [{ from: accountId }, { to: accountId }], date: window }).select('from to date amount reference contraNo fromName toName bankLineFrom bankLineTo').lean(),
  ]) : [[], []];
  // A contra is money in on the account it went to and out on the one it left.
  const recorded = [
    ...vouchers.map((v) => ({ ...v, voucherType: 'Payment' })),
    ...contras.filter((c) => !(String(c.to) === String(accountId) ? c.bankLineTo : c.bankLineFrom)).map((c) => {
      const incoming = String(c.to) === String(accountId);
      return { _id: c._id, voucherType: 'Contra', kind: incoming ? 'receipt' : 'payment', date: c.date, amount: c.amount, reference: c.reference || '', voucherNo: c.contraNo, partyName: incoming ? `From ${c.fromName}` : `To ${c.toName}` };
    }),
  ];
  // One book entry answers one statement line. Which one: the sure ones
  // are paired first (the references agree, or the dates are a day
  // apart at most: the bank's date and the book's often differ by one),
  // then what is left, nearest date first, so an entry made by hand a
  // few days from the bank's date still answers its line. A line never
  // takes an entry that sits on another line's own day.
  const used = new Set();
  const answer = new Map();
  const refsOf = (v, row) => {
    const a = String(row.ref || '').toUpperCase().trim(); const b = String(v.reference || '').toUpperCase().trim();
    return a && b ? (a.includes(b) || b.includes(a) ? 'agree' : 'differ') : 'none';
  };
  const pick = (row, sure) => {
    const kind = row.direction === 'in' ? 'receipt' : 'payment';
    let best = null;
    for (const v of recorded) {
      if (used.has(String(v._id)) || v.kind !== kind || Math.abs(v.amount - row.amount) >= 0.01) continue;
      const days = Math.abs(new Date(v.date) - row.date) / DAY;
      const refs = refsOf(v, row);
      if (refs === 'differ' || days > 5) continue;
      if (sure && !(refs === 'agree' || days <= 1)) continue;
      if (!best || days < best.days) best = { v, days };
    }
    if (!best) return;
    used.add(String(best.v._id));
    answer.set(row, best.v);
  };
  for (const row of rows) pick(row, true);
  for (const row of rows) if (!answer.has(row)) pick(row, false);

  const out = rows.map((row) => {
    // Already in the books?
    const dup = answer.get(row);
    if (dup) {
      return { ...row, status: 'recorded', suggestion: null, recorded: { _id: dup._id, voucherType: dup.voucherType, voucherNo: dup.voucherNo, partyName: dup.partyName } };
    }

    const partyType = row.direction === 'in' ? 'customer' : 'supplier';
    const groups = row.direction === 'in' ? recvByParty : payByParty;
    const openDocs = row.direction === 'in' ? recv : pay;
    const text = row.narration.toUpperCase();

    // 1. A document number in the narration.
    const named = namedIn(text, row.narration, openDocs);
    if (named) return { ...row, status: 'matched', suggestion: { partyType, ...suggestNamed(named, groups, row.amount) } };
    // 2. A payer or payee remembered from an earlier statement: the
    //    narration carries text a person once said is this party.
    const known = aliases.filter((a) => a.direction === row.direction && text.includes(a.text)).sort((a, b) => b.text.length - a.text.length)[0];
    if (known) {
      rememberedUsed.add(String(known._id));
      if (known.partyType === 'other') {
        return { ...row, status: 'matched', suggestion: { partyType: 'other', party: null, partyName: known.partyName, ...(known.head ? { head: known.head, headName: known.headName } : {}), ...(known.incomeLedger ? { incomeLedger: known.incomeLedger } : {}), allocations: [], confidence: 0.8, reason: `remembered: lines with "${known.text}" are ${known.partyName}${known.headName ? ` (${known.headName})` : known.incomeLedger === 'interest' ? ' (interest received)' : ''}`, remembered: String(known._id) } };
      }
      const group = groups.find((g) => String(g.party) === String(known.party));
      const docs = group?.docs || [];
      const exact = subsetFor(docs, row.amount);
      const pairs = exact ? exact.map((doc) => ({ doc })) : fifo(docs, row.amount);
      return { ...row, status: 'matched', suggestion: { partyType: known.partyType, party: known.party, partyName: known.partyName, allocations: alloc(pairs), confidence: exact ? 0.9 : docs.length ? 0.65 : 0.5, reason: `remembered: lines with "${known.text}" are ${known.partyName}${exact ? `; amount matches ${exact.map((d) => d.docNo).join(' + ')}` : docs.length ? '; allocated oldest first' : '; nothing open, stays on account'}`, remembered: String(known._id) } };
    }
    // 3. Money between our own accounts: another account's number in the
    //    narration, or cash drawn or paid in over the counter.
    const transfer = transferOf(row, otherAccounts, cashAccount);
    if (transfer) return { ...row, status: 'matched', suggestion: transfer };
    // 4. The party's name in the narration.
    const parties = partyType === 'customer' ? customers : suppliers;
    const scored = parties.map((p) => ({ p, s: nameScore(row.narration, p.name) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
    if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) {
      const party = scored[0].p;
      const group = groups.find((g) => String(g.party) === String(party._id));
      const docs = group?.docs || [];
      const exact = subsetFor(docs, row.amount);
      const pairs = exact ? exact.map((doc) => ({ doc })) : fifo(docs, row.amount);
      return { ...row, status: 'matched', suggestion: { partyType, party: party._id, partyName: party.name, allocations: alloc(pairs), confidence: exact ? 0.9 : docs.length ? 0.65 : 0.5, reason: exact ? `${party.name} in the narration, amount matches ${exact.map((d) => d.docNo).join(' + ')}` : docs.length ? `${party.name} in the narration; allocated oldest first` : `${party.name} in the narration; nothing open, stays on account` } };
    }
    // 5. One open document anywhere for exactly this amount.
    const exactAny = openDocs.filter((d) => Math.abs(d.outstanding - row.amount) < 1);
    if (exactAny.length === 1) {
      const d = exactAny[0];
      return { ...row, status: 'matched', suggestion: { partyType, party: d.party, partyName: d.partyName, allocations: alloc([{ doc: d }]), confidence: 0.7, reason: `the only open document for exactly ₹${row.amount.toLocaleString('en-IN')}: ${d.docNo}` } };
    }
    return { ...row, status: 'unmatched', suggestion: null, candidates: exactAny.slice(0, 5).map((d) => ({ partyType, party: d.party, partyName: d.partyName, docNo: d.docNo, docType: d.docType, doc: d.id })) };
  });

  // 6. The model, for lines the rules could not place: who it is and the
  //    documents it names, a transfer, an expense head, or income — each
  //    answer checked against what is on file (services/statementAi.js).
  const open = out.filter((r) => r.status === 'unmatched');
  if (useModel && open.length) {
    const [heads, examples] = await Promise.all([
      ExpenseCategory.find({ active: { $ne: false } }).select('name').lean(),
      placedBefore(accountId, aliases),
    ]);
    const placed = await statementAi.place(open, {
      recv, pay, recvByParty, payByParty, customers, suppliers, heads, examples,
      accounts: otherAccounts, thisAccount: thisAccount?.name || 'this account', subsetFor, fifo, alloc,
    });
    for (const [index, suggestion] of placed) {
      const row = out.find((r) => r.index === index);
      if (!row || row.status !== 'unmatched') continue;
      row.status = 'matched';
      row.suggestion = suggestion;
    }
  }
  if (rememberedUsed.size) await BankAlias.updateMany({ _id: { $in: [...rememberedUsed] } }, { $set: { lastMatchedAt: new Date() } });
  return out;
}

module.exports = { transferOf, sniff, htmlRows, openingOf, parse, parseDetailed, parseCsv, parseDate, columnsOf, sheetRows, match, nameScore, subsetFor, fifo, lineKey, closingOf, standsAlone, namedIn, suggestNamed };
