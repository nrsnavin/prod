'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CHEQUE PHOTO, INTO A RECEIPT OR A POST-DATED CHEQUE
//
//  fromPhoto({ pages, customer }) → { read, checks, customer, duplicate,
//    draft, aiSuggestion }
//
//  The cheque is read (utils/chequeOcr.js), then checked here, never by
//  the model:
//    · the figure against the amount in words (utils/amountWords.js);
//    · the date: dated ahead is a post-dated cheque, held until its day;
//      more than three months old, the bank will not pay it;
//    · who it is made out to (us?), whether it is signed, whether the
//      number printed agrees with the MICR line.
//  The drawer is matched to a customer: a payer the bank lines already
//  taught (models/BankAlias.js), else a name that is the same once
//  "Pvt Ltd" and punctuation are set aside. A cheque already entered —
//  the same number for the same amount — is named.
//
//  The draft is a receipt voucher's body, by cheque. Nothing is saved:
//  the receipt form opens filled in, and a person posts it. A cheque
//  dated ahead goes in like any received cheque and stays "in hand"
//  until its date (api/accountsCommon.js), which is the PDC register.
// ══════════════════════════════════════════════════════════════════

const Customer = require('../models/Customer');
const Payment = require('../models/Payment');
const bizDates = require('../utils/bizDates');
const { wordsToNumber } = require('../utils/amountWords');
const { readCustomerCheque } = require('../utils/chequeOcr');
const { nameScore } = require('./partyMatch');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const SURFACE = 'cheque-receipt-ocr';
/** A cheque is good for three months from its date (RBI, since April 2012). */
const VALID_MONTHS = 3;

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const dayOf = (iso) => new Date(`${iso}T00:00:00Z`);

/** Three calendar months before a day (the same date, or the month's last day). */
function monthsBefore(day, months) {
  const p = bizDates.parts(day);
  let m = p.m - months;
  let y = p.y;
  while (m < 1) { m += 12; y -= 1; }
  return bizDates.at(y, m, Math.min(p.d, bizDates.daysIn(y, m)));
}

/**
 * What a person should see before entering it. Each: { code, severity:
 * 'danger' | 'warning' | 'info', message }.
 */
function checkCheque(read, { today = bizDates.today(), firmName = '' } = {}) {
  const issues = [];
  const push = (code, severity, message) => issues.push({ code, severity, message });
  if (read.amount == null) push('NO_AMOUNT', 'danger', 'No amount in figures was read: type it from the cheque');
  const words = read.amountWords ? wordsToNumber(read.amountWords) : null;
  if (read.amount != null && read.amountWords) {
    if (words == null) push('WORDS', 'warning', `The amount in words ("${read.amountWords}") could not be checked against the figure: compare them yourself`);
    else if (Math.abs(words - read.amount) >= 0.01) push('WORDS', 'danger', `The words say ${rupees(words)}; the figure says ${rupees(read.amount)}. A bank pays neither until they agree`);
  } else if (read.amount != null && !read.amountWords) {
    push('WORDS', 'warning', 'No amount in words was read: check the cheque has one');
  }
  if (!read.date) {
    push('NO_DATE', 'warning', 'No date was read: a cheque without one cannot be deposited');
  } else {
    const d = dayOf(read.date);
    if (d > today) push('POST_DATED', 'info', `Dated ${bizDates.dmy(d, '/')}: a post-dated cheque, held in hand until then`);
    else if (d < monthsBefore(today, VALID_MONTHS)) push('STALE', 'danger', `Dated ${bizDates.dmy(d, '/')}: more than three months old, so the bank will not pay it`);
  }
  if (!read.chequeNo) push('NO_NUMBER', 'warning', 'The cheque number was not read: type it from the MICR line');
  const micrFirst = String(read.micr || '').split(' ')[0];
  if (read.chequeNo && /^\d{6}$/.test(micrFirst) && micrFirst !== read.chequeNo) push('MICR', 'warning', `The number read (${read.chequeNo}) differs from the MICR line (${micrFirst})`);
  if (read.payee && firmName && !sameFirm(read.payee, firmName)) push('PAYEE', 'warning', `Made out to "${read.payee}", not to ${firmName}`);
  if (read.signed === false) push('UNSIGNED', 'warning', 'No signature was seen');
  return issues;
}

function sameFirm(a, b) {
  const { sameName } = require('../utils/kycOcr');
  return sameName(a, b) || nameScore(a, b) >= 0.75;
}

/**
 * The customer who wrote it: a payer the bank lines taught us, else the
 * name. { _id, name, matchedBy } or null — never a guess between two.
 */
async function matchDrawer(read) {
  const drawer = String(read.drawer || '').trim();
  if (!drawer) return null;
  const upper = drawer.toUpperCase().replace(/\s+/g, ' ');
  const BankAlias = require('../models/BankAlias');
  const aliases = await BankAlias.find({ direction: 'in', partyType: 'customer', party: { $ne: null } }).select('text party partyName').lean();
  const alias = aliases.find((a) => a.text && upper.includes(String(a.text).toUpperCase()));
  if (alias) {
    const c = await Customer.findById(alias.party).select('name').lean();
    if (c) return { _id: c._id, name: c.name, matchedBy: 'payer' };
  }
  const customers = await Customer.find({}).select('name').lean();
  const scored = customers.map((c) => ({ c, s: sameFirm(drawer, c.name) ? Math.max(0.9, nameScore(drawer, c.name)) : nameScore(drawer, c.name) }))
    .filter((x) => x.s >= 0.75).sort((x, y) => y.s - x.s);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].s >= scored[0].s - 0.1) return null;
  return { _id: scored[0].c._id, name: scored[0].c.name, matchedBy: 'name' };
}

/** A receipt already entered for this cheque: the same number, for the same amount (or from the same bank). */
async function duplicateOf(read) {
  if (!read.chequeNo) return null;
  const rows = await Payment.find({ kind: 'receipt', mode: 'cheque', status: 'posted', 'cheque.number': read.chequeNo })
    .select('voucherNo date amount partyName cheque.bank').limit(5).lean();
  const bank = String(read.bankName || '').toLowerCase().split(/\s+/)[0];
  const same = rows.find((r) => (read.amount != null && Math.abs(r.amount - read.amount) < 0.01) || (bank && String(r.cheque?.bank || '').toLowerCase().includes(bank)));
  return same ? { _id: same._id, voucherNo: same.voucherNo, date: same.date, amount: same.amount, partyName: same.partyName } : null;
}

/** The receipt's body, by cheque, for the form to open with. */
function draftOf(read, customer, today = bizDates.today()) {
  const bank = [read.bankName, read.branch].filter(Boolean).join(', ').slice(0, 80);
  return {
    kind: 'receipt', partyType: 'customer',
    customer: customer ? String(customer._id) : null, partyName: customer?.name || read.drawer || '',
    amount: read.amount, mode: 'cheque', reference: read.chequeNo,
    cheque: { number: read.chequeNo, bank, date: read.date || null },
    postDated: !!read.date && dayOf(read.date) > today,
  };
}

/**
 * The whole step. `customer` (an id) when the person already picked
 * who paid; `refType`/`refId` tie the read to where it came from.
 * Throws the reader's coded errors (no key, not a photo) for the route.
 */
async function fromPhoto({ pages, customer = null, refType, refId } = {}) {
  const startedAt = Date.now();
  let read;
  try {
    read = await readCustomerCheque(pages);
  } catch (err) {
    if (!err.code) await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
    throw err;
  }
  const { model, usage, latencyMs, ...fields } = read;
  // Scored on what a person keeps or changes in the receipt: the number,
  // the date, the amount and who paid.
  const record = (party) => aiLedger.record({
    surface: SURFACE, model, promptVersion: promptVersion(SURFACE), refType, refId,
    proposed: fields.problem ? { problem: fields.problem } : { chequeNo: fields.chequeNo, date: fields.date, amount: fields.amount, customer: party ? String(party._id) : null },
    latencyMs, usage,
  }).then((id) => (id ? String(id) : null)).catch(() => null);
  if (fields.problem) return { read: fields, checks: [], customer: null, duplicate: null, draft: null, aiSuggestion: await record(null) };
  const { getDocumentSettings } = require('./documentSettings');
  const firmName = (await getDocumentSettings().catch(() => null))?.companyName || '';
  const today = bizDates.today();
  let party = null;
  if (customer) {
    const c = await Customer.findById(customer).select('name').lean();
    if (c) party = { _id: c._id, name: c.name, matchedBy: 'picked' };
  }
  if (!party) party = await matchDrawer(fields);
  return {
    read: fields,
    checks: checkCheque(fields, { today, firmName }),
    customer: party ? { _id: String(party._id), name: party.name, matchedBy: party.matchedBy } : null,
    duplicate: await duplicateOf(fields),
    draft: draftOf(fields, party, today),
    aiSuggestion: await record(party),
  };
}

/** What a posted receipt kept of the read, to score it on the AI ledger. */
function accepted(voucher) {
  return {
    chequeNo: voucher.cheque?.number || voucher.reference || '',
    date: voucher.cheque?.date ? new Date(voucher.cheque.date).toISOString().slice(0, 10) : '',
    amount: voucher.amount,
    customer: voucher.customer ? String(voucher.customer) : null,
  };
}

module.exports = { fromPhoto, checkCheque, matchDrawer, duplicateOf, draftOf, accepted, monthsBefore, SURFACE };
