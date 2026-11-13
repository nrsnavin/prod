'use strict';
// ══════════════════════════════════════════════════════════════════
//  TDS PAPERS, INTO THE REGISTERS
//
//    challan(pages)  a TDS challan receipt → the register's challan row:
//                    BSR code, challan number, date, section, the tax and
//                    the interest, and the month it is for — the month
//                    whose deduction under that section it pays off
//                    exactly, else the month before a deposit made by the
//                    7th (when TDS falls due), else the month it was paid
//    form16a(pages)  a customer's TDS certificate → the certificate row:
//                    the customer by TAN (else name), the year and quarter,
//                    the number, section and tax; refused as ours when the
//                    deductee's PAN is not our own (it is in our GSTIN)
//    as26(pages)     Form 26AS as a PDF or photos → the year's lines, each
//                    placed on a customer exactly as the CSV import does
//
//  Nothing is entered by challan() and form16a(): they return the body
//  the register's own routes take, for a person to save. as26() replaces
//  the year's 26AS lines, as uploading the file always has.
// ══════════════════════════════════════════════════════════════════

const TdsChallan = require('../models/TdsChallan');
const TdsCertificate = require('../models/TdsCertificate');
const Customer = require('../models/Customer');
const tds = require('./tds');
const bizDates = require('../utils/bizDates');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const { nameScore } = require('./partyMatch');
const { r2 } = require('../utils/money');

const SURFACE = 'tds-paper-ocr';
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function readWith(reader, pages, kind) {
  const startedAt = Date.now();
  let read;
  try {
    read = await reader(pages);
  } catch (err) {
    if (!err.code) await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: `${kind}: ${err.message}` }).catch(() => null);
    throw err;
  }
  const { model, usage, latencyMs, ...fields } = read;
  const record = (proposed) => aiLedger.record({ surface: SURFACE, model, promptVersion: promptVersion(SURFACE), proposed: { kind, ...proposed }, latencyMs, usage })
    .then((id) => (id ? String(id) : null)).catch(() => null);
  return { fields, record };
}

/** "2027-28" (an assessment year) → "2026-27" (its financial year). */
function fyOfAy(ay) {
  const m = String(ay || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]) - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}

/** The month a challan pays for. → { month, why } */
async function monthFor(read) {
  const paid = new Date(`${read.depositedOn}T00:00:00Z`);
  const p = bizDates.parts(paid);
  const here = bizDates.monthKey(paid);
  const candidates = [0, 1, 2, 3].map((k) => bizDates.shiftMonth(here, -k));
  const tax = r2((read.tax || 0) + (read.surcharge || 0) + (read.cess || 0));
  for (const month of candidates) {
    const reg = await tds.register(month).catch(() => null);
    const row = reg?.rows?.find((r) => r.section === read.section);
    if (row && row.balance > 0.005 && Math.abs(row.balance - tax) < 1) return { month, why: `${month}'s ${read.section} deductions, ${rupees(row.balance)}, are still to be deposited: this pays them exactly` };
  }
  if (p.d <= 7) return { month: candidates[1], why: `Paid by the 7th: taken as last month's deductions, which fall due then` };
  return { month: here, why: 'Taken as this month\'s deductions: change it if it pays an earlier month' };
}

async function challan({ pages } = {}) {
  const { fields, record } = await readWith(require('../utils/paperReaders').readTdsChallan, pages, 'challan');
  if (fields.problem) return { read: fields, draft: null, checks: [], duplicate: null, aiSuggestion: await record({ problem: fields.problem }) };
  const checks = [];
  const flag = (code, severity, message) => checks.push({ code, severity, message });
  if (!fields.bsrCode) flag('BSR', 'danger', 'The BSR code was not read: type the 7 digits from the challan');
  if (!fields.challanNo) flag('NUMBER', 'danger', 'The challan number was not read');
  if (!fields.depositedOn) flag('DATE', 'danger', 'The date of deposit was not read');
  if (!fields.section) flag('SECTION', 'danger', 'The section was not read: pick it (194C, 194J, 194Q…)');
  if (fields.minorHead && fields.minorHead !== '200') flag('MINOR_HEAD', 'warning', `Minor head ${fields.minorHead}: not TDS payable by us (200). Check it is a challan for our TDS`);
  const tax = r2((fields.tax || 0) + (fields.surcharge || 0) + (fields.cess || 0));
  const parts = r2(tax + (fields.interest || 0) + (fields.fee || 0) + (fields.penalty || 0));
  if (fields.total != null && parts > 0 && Math.abs(parts - fields.total) > 1) flag('TOTAL', 'warning', `Tax ${rupees(tax)} with interest and fee makes ${rupees(parts)}; the challan's total is ${rupees(fields.total)}`);
  if (fields.fee) flag('FEE', 'info', `A late-filing fee of ${rupees(fields.fee)} (s.234E) is on this challan: it is not TDS, and is not in the register`);
  let month = null;
  let duplicate = null;
  if (fields.depositedOn) {
    month = await monthFor(fields);
    if (fields.bsrCode && fields.challanNo) {
      const d = await TdsChallan.findOne({ bsrCode: fields.bsrCode, challanNo: fields.challanNo, depositedOn: new Date(`${fields.depositedOn}T00:00:00Z`) }).select('month section amount').lean();
      if (d) duplicate = { _id: String(d._id), month: d.month, section: d.section, amount: d.amount };
    }
  }
  const draft = fields.depositedOn && (tax > 0 || fields.total) ? {
    month: month?.month || '', monthWhy: month?.why || '', section: fields.section, amount: tax > 0 ? tax : r2(fields.total || 0), interest: r2(fields.interest || 0),
    bsrCode: fields.bsrCode, challanNo: fields.challanNo, depositedOn: fields.depositedOn,
    note: [fields.cin ? `CIN ${fields.cin}` : '', fields.fee ? `Fee ${rupees(fields.fee)}` : ''].filter(Boolean).join(' · '),
  } : null;
  return { read: fields, draft, checks, duplicate, aiSuggestion: await record({ bsrCode: fields.bsrCode, challanNo: fields.challanNo, depositedOn: fields.depositedOn, section: fields.section, amount: draft?.amount ?? null }) };
}

async function customerFor(read) {
  if (/^[A-Z]{4}\d{5}[A-Z]$/.test(read.deductorTan || '')) {
    const c = await Customer.findOne({ tan: read.deductorTan }).select('name tan').lean();
    if (c) return { ...c, matchedBy: 'tan' };
  }
  if (!read.deductorName) return null;
  const all = await Customer.find({}).select('name tan').lean();
  const scored = all.map((c) => ({ c, s: nameScore(read.deductorName, c.name) })).filter((x) => x.s >= 0.75).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored.length > 1 && scored[1].s >= scored[0].s - 0.1)) return null;
  return { ...scored[0].c, matchedBy: 'name' };
}

async function form16a({ pages } = {}) {
  const { fields, record } = await readWith(require('../utils/paperReaders').readForm16a, pages, 'form16a');
  if (fields.problem) return { read: fields, customer: null, draft: null, checks: [], duplicate: null, aiSuggestion: await record({ problem: fields.problem }) };
  const checks = [];
  const flag = (code, severity, message) => checks.push({ code, severity, message });
  const { getDocumentSettings } = require('./documentSettings');
  const ourGstin = String((await getDocumentSettings().catch(() => null))?.gstin || '').toUpperCase();
  const ourPan = /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(ourGstin) ? ourGstin.slice(2, 12) : '';
  if (ourPan && fields.deducteePan && fields.deducteePan !== ourPan) flag('PAN', 'danger', `Issued to PAN ${fields.deducteePan}, not ours (${ourPan}): this certificate is not for us`);
  const party = await customerFor(fields);
  if (!party) flag('CUSTOMER', 'danger', `${fields.deductorName || 'The deductor'}${fields.deductorTan ? ` (TAN ${fields.deductorTan})` : ''} is not matched to a customer: pick one`);
  const fy = fyOfAy(fields.assessmentYear) || (fields.periodFrom ? bizDates.fyOf(new Date(`${fields.periodFrom}T00:00:00Z`)) : null);
  if (!fy) flag('YEAR', 'warning', 'The year was not read: pick it');
  if (!fields.quarter) flag('QUARTER', 'warning', 'The quarter was not read: pick it');
  const amount = fields.totalTds != null ? fields.totalTds : r2(fields.rows.reduce((t, x) => t + (x.tds || 0), 0));
  const sections = [...new Set(fields.rows.map((x) => x.section).filter(Boolean))];
  if (sections.length > 1) flag('SECTIONS', 'info', `It covers sections ${sections.join(', ')}: recorded as one certificate under ${sections[0]}`);
  let duplicate = null;
  if (party && fy && fields.quarter && fields.certificateNo) {
    const d = await TdsCertificate.findOne({ kind: 'received', party: party._id, fy, quarter: fields.quarter, certNo: fields.certificateNo }).select('amount').lean();
    if (d) duplicate = { _id: String(d._id), amount: d.amount };
  }
  const draft = {
    kind: 'received', party: party ? String(party._id) : null, partyName: party?.name || fields.deductorName,
    fy: fy || '', quarter: fields.quarter, certNo: fields.certificateNo, section: sections[0] || '', amount, on: bizDates.today().toISOString().slice(0, 10),
    tan: fields.deductorTan,
  };
  return {
    read: fields, customer: party ? { _id: String(party._id), name: party.name, matchedBy: party.matchedBy } : null, draft, checks, duplicate,
    aiSuggestion: await record({ customer: party ? String(party._id) : null, fy, quarter: fields.quarter, certNo: fields.certificateNo, amount }),
  };
}

/** Form 26AS read from its PDF: the year's lines replaced with these, each placed on a customer. */
async function as26({ pages, fy: given, by } = {}) {
  const { fields, record } = await readWith(require('../utils/paperReaders').read26as, pages, '26as');
  if (fields.problem) return { read: { problem: fields.problem }, stored: null, aiSuggestion: await record({ problem: fields.problem }) };
  const fy = fyOfAy(fields.assessmentYear) || given;
  if (!fy) throw Object.assign(new Error('The year of this Form 26AS was not read: pick it and read it again'), { status: 400 });
  if (!fields.rows.length) throw Object.assign(new Error('No lines were read from Part I of this Form 26AS'), { status: 400 });
  const stored = await tds.store26as({ fy, rows: fields.rows.map(({ status, ...x }) => x), by });
  return { read: { pan: fields.pan, assessmentYear: fields.assessmentYear, lines: fields.rows.length }, stored, aiSuggestion: await record({ lines: fields.rows.length, tds: r2(fields.rows.reduce((t, x) => t + x.tds, 0)) }) };
}

module.exports = { challan, form16a, as26, monthFor, fyOfAy, customerFor, SURFACE };
