'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAPERS THAT REACH ACCOUNTS, READ INTO JSON
//
//    readDebitNote(pages)   a customer's debit note, or a letter saying
//                           they paid an invoice short and why
//    readTdsChallan(pages)  a TDS challan receipt (ITNS 281 / e-pay)
//    readForm16a(pages)     a customer's TDS certificate to us
//    read26as(pages)        Form 26AS Part I, as a PDF or photos
//    readPriceList(pages)   a supplier's price list or quotation
//    readPowerBill(pages)   the factory's electricity bill
//
//  Each only copies what is printed: every check (does it add up, is
//  the PAN ours, is this challan entered already) is the server's, in
//  the service that uses the read. Each throws docRead's coded errors
//  (no photo, not a photo, no AI key) for the route to word.
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? String(v) : '');
const money = (v) => { const n = num(v); return n != null && n >= 0 && n < 1e11 ? Math.round(n * 100) / 100 : null; };
const upper = (v, max) => str(v, max).toUpperCase().replace(/\s+/g, '');
const meta = (r) => ({ model: r.model, usage: r.usage, latencyMs: r.latencyMs });
const problemOf = (raw, own) => (!raw ? 'unreadable' : raw.problem === own || raw.problem === 'unreadable' ? raw.problem : null);

// ── A customer's debit note ──────────────────────────────────────
const DEBIT_NOTE_PROMPT = [
  'This is a paper from a customer of an elastic (narrow fabric) factory in Tamil Nadu: their debit note to the factory, or a letter or mail',
  'saying they paid less than an invoice and why (goods short, goods rejected, a rate difference, a late-delivery penalty, a discount taken).',
  'Read it. Return ONLY JSON:',
  '{"problem":null,"kind":"debit_note","customerName":"Sunrise Garments Pvt Ltd","customerGstin":"33AAEPS1001F1Z2","noteNo":"DN/112","date":"2026-11-08",',
  ' "invoices":["INV/2026-27/0701"],"reason":"12 rolls short received","taxable":4000,"gst":200,"total":4200,',
  ' "lines":[{"description":"Shortage, 12 rolls 20mm white","quantity":12,"rate":333.33,"amount":4000}]}',
  '- problem: "not_a_debit_note" when it is neither a debit note nor a short-payment letter; "unreadable" when it cannot be read; else null.',
  '- kind: debit_note or short_payment. customerName / customerGstin: whoever issued it (the customer), not the factory.',
  '- invoices: the FACTORY\'s invoice numbers it names, exactly as written. date: YYYY-MM-DD.',
  '- taxable, gst, total: the amounts it claims, in rupees; null when not printed. reason: why, in one short English sentence.',
  '- lines: as printed (else []). Never guess a number.',
].join('\n');

async function readDebitNote(pages) {
  const r = await readJson({ pages, prompt: DEBIT_NOTE_PROMPT, maxTokens: 1500, maxPages: 3 });
  const raw = r.data;
  const problem = problemOf(raw, 'not_a_debit_note');
  if (problem) return { problem, ...meta(r) };
  return {
    problem: null,
    kind: raw.kind === 'short_payment' ? 'short_payment' : 'debit_note',
    customerName: str(raw.customerName, 120), customerGstin: upper(raw.customerGstin, 15),
    noteNo: str(raw.noteNo, 40), date: isoDate(raw.date),
    invoices: (Array.isArray(raw.invoices) ? raw.invoices : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 10),
    reason: str(raw.reason, 200),
    taxable: money(raw.taxable), gst: money(raw.gst), total: money(raw.total),
    lines: (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 30).map((l) => ({
      description: str(l?.description, 200), quantity: num(l?.quantity), rate: money(l?.rate), amount: money(l?.amount),
    })).filter((l) => l.description),
    ...meta(r),
  };
}

// ── A TDS challan ────────────────────────────────────────────────
const CHALLAN_PROMPT = [
  'This is a TDS challan receipt from India: the ITNS 281 counterfoil, or the "Challan Receipt" of the income-tax e-pay tax service or a bank,',
  'for tax a company deducted at source and paid to the government. Return ONLY JSON:',
  '{"problem":null,"tan":"CHEB12345C","bsrCode":"0510308","challanNo":"12345","depositedOn":"2026-11-07","section":"194C","natureOfPayment":"Payments to contractors",',
  ' "minorHead":"200","assessmentYear":"2027-28","tax":15000,"surcharge":0,"cess":0,"interest":0,"fee":0,"penalty":0,"total":15000,"cin":""}',
  '- problem: "not_a_challan" when it is not a tax challan; "unreadable" when it cannot be read; else null.',
  '- bsrCode: the 7-digit BSR code. challanNo: the challan serial number (usually 5 digits). depositedOn: the date of deposit, YYYY-MM-DD.',
  '- section: the TDS section code (192, 194A, 194C, 194H, 194I, 194J, 194Q …) from the nature of payment. minorHead: 200 or 400.',
  '- Amounts in rupees; null when not printed. Never guess a digit.',
].join('\n');

async function readTdsChallan(pages) {
  const r = await readJson({ pages, prompt: CHALLAN_PROMPT, maxTokens: 800, maxPages: 2 });
  const raw = r.data;
  const problem = problemOf(raw, 'not_a_challan');
  if (problem) return { problem, ...meta(r) };
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  return {
    problem: null,
    tan: upper(raw.tan, 10), bsrCode: /^\d{7}$/.test(digits(raw.bsrCode)) ? digits(raw.bsrCode) : '',
    challanNo: digits(raw.challanNo).slice(0, 10), depositedOn: isoDate(raw.depositedOn),
    section: upper(raw.section, 8), natureOfPayment: str(raw.natureOfPayment, 80), minorHead: digits(raw.minorHead).slice(0, 3),
    assessmentYear: str(raw.assessmentYear, 9),
    tax: money(raw.tax), surcharge: money(raw.surcharge), cess: money(raw.cess), interest: money(raw.interest), fee: money(raw.fee), penalty: money(raw.penalty), total: money(raw.total),
    cin: str(raw.cin, 40),
    ...meta(r),
  };
}

// ── Form 16A ─────────────────────────────────────────────────────
const FORM16A_PROMPT = [
  'This is Form 16A: a TDS certificate an Indian company (the deductor, our customer) issued to an elastic factory (the deductee) for tax it deducted',
  'from what it paid the factory. Return ONLY JSON:',
  '{"problem":null,"deductorName":"Sunrise Garments Pvt Ltd","deductorTan":"CHES12345D","deducteeName":"Balu Elastics","deducteePan":"AABFB1234C",',
  ' "certificateNo":"ABCDEFG","assessmentYear":"2027-28","quarter":"Q2","periodFrom":"2026-07-01","periodTo":"2026-09-30",',
  ' "rows":[{"section":"194Q","amountPaid":500000,"tds":500}],"totalTds":500}',
  '- problem: "not_a_form16a" when it is not a TDS certificate; "unreadable"; else null.',
  '- quarter: Q1 (Apr–Jun), Q2 (Jul–Sep), Q3 (Oct–Dec), Q4 (Jan–Mar). rows: amounts paid or credited and tax deducted, by section.',
  '- Amounts in rupees. Never guess a digit or a letter.',
].join('\n');

async function readForm16a(pages) {
  const r = await readJson({ pages, prompt: FORM16A_PROMPT, maxTokens: 1000, maxPages: 3 });
  const raw = r.data;
  const problem = problemOf(raw, 'not_a_form16a');
  if (problem) return { problem, ...meta(r) };
  return {
    problem: null,
    deductorName: str(raw.deductorName, 120), deductorTan: upper(raw.deductorTan, 10),
    deducteeName: str(raw.deducteeName, 120), deducteePan: upper(raw.deducteePan, 10),
    certificateNo: upper(raw.certificateNo, 20), assessmentYear: str(raw.assessmentYear, 9),
    quarter: ['Q1', 'Q2', 'Q3', 'Q4'].includes(String(raw.quarter || '').toUpperCase()) ? String(raw.quarter).toUpperCase() : '',
    periodFrom: isoDate(raw.periodFrom), periodTo: isoDate(raw.periodTo),
    rows: (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 20).map((x) => ({ section: upper(x?.section, 8), amountPaid: money(x?.amountPaid), tds: money(x?.tds) })).filter((x) => x.tds != null),
    totalTds: money(raw.totalTds),
    ...meta(r),
  };
}

// ── Form 26AS ────────────────────────────────────────────────────
const AS26_PROMPT = [
  'These pages are Form 26AS (or the TDS part of the AIS) of an Indian business, downloaded from the income-tax portal. Part I lists tax deducted',
  'at source by each deductor. Read every transaction line of Part I (not the deductor totals). Return ONLY JSON:',
  '{"problem":null,"pan":"AABFB1234C","assessmentYear":"2027-28",',
  ' "rows":[{"deductorName":"SUNRISE GARMENTS PVT LTD","tan":"CHES12345D","section":"194Q","date":"2026-07-15","amountPaid":500000,"tds":500,"status":"F"}]}',
  '- problem: "not_26as" when it is not Form 26AS or the AIS; "unreadable"; else null.',
  '- date: the transaction date, YYYY-MM-DD. status: the booking status letter (F, U, P, O) when printed. Never guess a digit.',
].join('\n');

async function read26as(pages) {
  const r = await readJson({ pages, prompt: AS26_PROMPT, maxTokens: 12000, maxPages: 6 });
  const raw = r.data;
  const problem = problemOf(raw, 'not_26as');
  if (problem) return { problem, ...meta(r) };
  return {
    problem: null,
    pan: upper(raw.pan, 10), assessmentYear: str(raw.assessmentYear, 9),
    rows: (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 2000).map((x) => ({
      deductorName: str(x?.deductorName, 120), tan: upper(x?.tan, 10), section: upper(x?.section, 8),
      date: isoDate(x?.date) ? new Date(`${x.date}T00:00:00Z`) : null, amountPaid: money(x?.amountPaid) ?? 0, tds: money(x?.tds) ?? 0, status: upper(x?.status, 2),
    })).filter((x) => x.tds > 0 && (x.tan || x.deductorName)),
    ...meta(r),
  };
}

// ── A supplier's price list or quotation ─────────────────────────
const PRICE_LIST_PROMPT = [
  'This is a supplier\'s price list or quotation to an elastic (narrow fabric) factory in Tamil Nadu: yarn (polyester, nylon, spandex / rubber),',
  'covering, dyes and chemicals, packing material, or spares. Return ONLY JSON:',
  '{"problem":null,"kind":"quotation","supplierName":"Sri Yarn Traders","supplierGstin":"33AAAPS0001F1Z5","ref":"Q/118","date":"2026-11-01","validUntil":"2026-11-30",',
  ' "lines":[{"description":"Nylon 70D/24F semi-dull","rate":310,"unit":"kg","gstPercent":5,"minQty":100}]}',
  '- problem: "not_a_price_list" when it is not a price list or quotation; "unreadable"; else null. kind: price_list or quotation.',
  '- rate: per unit, before GST, in rupees. unit as written (kg, m, pcs, roll, box). minQty: the minimum order when printed, else null.',
  '- One line per item priced. Never guess a number.',
].join('\n');

async function readPriceList(pages) {
  const r = await readJson({ pages, prompt: PRICE_LIST_PROMPT, maxTokens: 4000, maxPages: 4 });
  const raw = r.data;
  const problem = problemOf(raw, 'not_a_price_list');
  if (problem) return { problem, ...meta(r) };
  return {
    problem: null,
    kind: raw.kind === 'price_list' ? 'price_list' : 'quotation',
    supplierName: str(raw.supplierName, 120), supplierGstin: upper(raw.supplierGstin, 15), ref: str(raw.ref, 40),
    date: isoDate(raw.date), validUntil: isoDate(raw.validUntil),
    lines: (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 200).map((l) => ({
      description: str(l?.description, 200), rate: money(l?.rate), unit: str(l?.unit, 10), gstPercent: num(l?.gstPercent), minQty: num(l?.minQty),
    })).filter((l) => l.description && l.rate != null && l.rate > 0),
    ...meta(r),
  };
}

// ── The electricity bill ─────────────────────────────────────────
const POWER_BILL_PROMPT = [
  'This is the electricity bill of a factory in Tamil Nadu (TANGEDCO / TNPDCL, an HT or LT service). Return ONLY JSON:',
  '{"problem":null,"consumerNo":"059-001-234","billNo":"","billDate":"2026-11-05","periodFrom":"2026-10-01","periodTo":"2026-10-31","units":24850,"demandKva":180,',
  ' "energyCharges":186375,"demandCharges":63000,"otherCharges":4200,"tax":12430,"total":266005,"dueDate":"2026-11-20"}',
  '- problem: "not_a_power_bill" when it is not an electricity bill; "unreadable"; else null.',
  '- units: kWh used in the period (all time-of-day slots added). energyCharges: the charge for those units. demandCharges: fixed or demand charges.',
  '- otherCharges: everything else for the period (meter rent, power-factor penalty, fuel cost adjustment). tax: electricity tax.',
  '- total: what is payable for this period, not arrears. Dates YYYY-MM-DD. Amounts in rupees. Never guess a number.',
].join('\n');

async function readPowerBill(pages) {
  const r = await readJson({ pages, prompt: POWER_BILL_PROMPT, maxTokens: 800, maxPages: 3 });
  const raw = r.data;
  const problem = problemOf(raw, 'not_a_power_bill');
  if (problem) return { problem, ...meta(r) };
  return {
    problem: null,
    consumerNo: str(raw.consumerNo, 40), billNo: str(raw.billNo, 40), billDate: isoDate(raw.billDate),
    periodFrom: isoDate(raw.periodFrom), periodTo: isoDate(raw.periodTo),
    units: money(raw.units), demandKva: money(raw.demandKva),
    energyCharges: money(raw.energyCharges), demandCharges: money(raw.demandCharges), otherCharges: money(raw.otherCharges), tax: money(raw.tax), total: money(raw.total),
    dueDate: isoDate(raw.dueDate),
    ...meta(r),
  };
}

module.exports = {
  readDebitNote, readTdsChallan, readForm16a, read26as, readPriceList, readPowerBill,
  PROMPTS: { DEBIT_NOTE_PROMPT, CHALLAN_PROMPT, FORM16A_PROMPT, AS26_PROMPT, PRICE_LIST_PROMPT, POWER_BILL_PROMPT },
};
