"use strict";
// ══════════════════════════════════════════════════════════════════
//  STATUTORY  (inside /api/v2/accounts)
//
//    GET  /msme                         open dues to micro and small
//                                       suppliers, by the 45-day rule
//    GET  /msme/year-end?fy=2026-27     s.43B(h): allowed, late, disallowed
//    GET  /msme/form1?asOf=2026-09-30   MSME Form I rows (?format=xlsx)
//    GET  /gstr2b?period=2026-10        the month's 2B against the books
//    POST /gstr2b/upload                the portal's GSTR-2B JSON (file)
//    POST /gstr2b/reconcile             match the month again
//    GET  /itc-reversal?month=2026-10   Rule 37: bills past 180 days
//    POST /bills/:id/itc-reverse        record the reversal for a month
//    POST /bills/:id/itc-reclaim        record the re-claim for a month
//    GET  /gstr1?month=2026-10          the return's tables and checks
//    GET  /gstr1/json?month=            the offline tool's JSON
//    GET  /gstr1/xlsx?month=            the tables as Excel
//    GET  /tds/register?month=          deducted, due, deposited, balance
//    POST /tds/challans                 a challan deposited
//    GET  /tds/26q?fy=&q=Q3             the quarter's return rows (?format=xlsx)
//    GET  /tds/certificates?fy=         Form 16A issued and received
//    POST /tds/certificates             record one
//    GET  /tds/receivable?fy=           what customers deducted, vs 26AS
//    POST /tds/26as                     upload Form 26AS (CSV / Excel)
//    GET  /tds/194q?fy=                 purchases against the ₹50 lakh limit
//    GET  /payroll-books?month=         the month's payroll and its journals
//    POST /payroll-books/salary         post (or re-post) the salary journal
//    POST /payroll-books/paid           post the cash paid out
//    POST /payroll-books/deposits       PF / ESI / PT deposited
//    GET  /service-bills/:id/draft      a machine's service bill, as a bill draft
//    GET  /credit-note-limit?invoice=   s.34(2): the last day for a GST credit note
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const { r2 } = require("../utils/money");
const cal = require("../utils/bizDates");
const multer = require("multer");
const ExcelJS = require("exceljs");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { ACTION_CODES } = require("../utils/fingerprint");
const { isId, readDate, fp } = require("../services/accountsHelpers");
const { once } = require("../services/posting");
const msme = require("../services/msme");
const gstr2b = require("../services/gstr2b");
const itcReversal = require("../services/itcReversal");
const gstr1 = require("../services/gstr1");
const tds = require("../services/tds");
const payrollBooks = require("../services/payrollBooks");
const creditNoteLimit = require("../services/creditNoteLimit");
const TdsCertificate = require("../models/TdsCertificate");
const MachineServiceBill = require("../models/MachineServiceBill");
const Supplier = require("../models/Supplier");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const { isAdmin } = require("../middleware/auth");
const serviceErr = (err, next) => (err.status ? next(new ErrorHandler(err.message, err.status)) : Promise.reject(err));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const MONTH = /^\d{4}-\d{2}$/;
const lastMonth = () => cal.shiftMonth(cal.monthKey(), -1);   // by the books' calendar
const monthOf = (q) => (MONTH.test(String(q || "")) ? q : lastMonth());
const fyOf = (q) => (/^\d{4}-\d{2}$/.test(String(q || "")) ? q : cal.fyOf());
const dd = (d) => cal.dmy(d);
async function sendXlsx(res, name, wb) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\w.-]+/g, "_")}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}
const money = (ws, cols) => { for (const c of cols) ws.getColumn(c).numFmt = "#,##0.00"; };

// ── MSME ───────────────────────────────────────────────────────────
router.get("/msme", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await msme.dues()) });
}));

router.get("/msme/year-end", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await msme.yearEnd(fyOf(req.query.fy))) });
}));

router.get("/msme/form1", catchAsyncErrors(async (req, res, next) => {
  let asOf;
  try { asOf = readDate(req.query.asOf, "asOf", null); } catch (err) { return next(err); }
  const r = await msme.formOne(asOf);
  if (req.query.format !== "xlsx") return res.json({ success: true, ...r });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("MSME Form I");
  ws.addRow([`Dues to micro and small enterprises outstanding more than 45 days as on ${dd(r.asOf)}`]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(["Supplier", "Udyam no.", "Category", "Our bill", "Supplier's invoice", "Invoice date", "Amount due", "Days outstanding", "Reason for delay"]).font = { bold: true };
  for (const x of r.rows) ws.addRow([x.partyName, x.udyam, x.category, x.docNo, x.refNo, dd(x.date), x.amount, x.daysOutstanding, x.reason]);
  ws.addRow(["Total", "", "", "", "", "", r.total]).font = { bold: true };
  ws.columns = [{ width: 32 }, { width: 22 }, { width: 10 }, { width: 18 }, { width: 18 }, { width: 13 }, { width: 15 }, { width: 10 }, { width: 24 }];
  money(ws, [7]);
  await sendXlsx(res, `MSME Form I ${dd(r.asOf)}`, wb);
}));

// ── GSTR-2B ────────────────────────────────────────────────────────
router.get("/gstr2b", catchAsyncErrors(async (req, res) => {
  const period = monthOf(req.query.period);
  res.json({ success: true, ...(await gstr2b.summary(period)), periods: await gstr2b.periods() });
}));

router.post("/gstr2b/upload", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  if (!req.file) return next(new ErrorHandler("Attach the GSTR-2B JSON downloaded from the GST portal", 400));
  let json;
  try { json = JSON.parse(req.file.buffer.toString("utf8")); } catch { return next(new ErrorHandler("The file is not JSON. Download GSTR-2B as JSON (not Excel) from the portal.", 400)); }
  // The period from the file when it says (rtnprd "102026"), else the form.
  const rtn = String(json?.data?.rtnprd || json?.rtnprd || "");
  const period = MONTH.test(String(req.body?.period || "")) ? req.body.period : /^\d{6}$/.test(rtn) ? `${rtn.slice(2)}-${rtn.slice(0, 2)}` : null;
  if (!period) return next(new ErrorHandler("Say which month this GSTR-2B is for (period=YYYY-MM)", 400));
  try {
    res.json({ success: true, ...(await gstr2b.upload({ period, json, by: req.user?._id })), periods: await gstr2b.periods() });
  } catch (err) {
    if (err.status === 400) return next(new ErrorHandler(err.message, 400));
    throw err;
  }
}));

// For each supplier with bills missing from (or misreported in) the month's
// 2B: the bills, the tax held up, and a message asking them to report it.
router.get("/gstr2b/follow-ups", catchAsyncErrors(async (req, res, next) => {
  const period = String(req.query?.period || "");
  if (!MONTH.test(period)) return next(new ErrorHandler("period must be YYYY-MM", 400));
  res.json({ success: true, period, suppliers: await gstr2b.followUps(period) });
}));

router.post("/gstr2b/reconcile", catchAsyncErrors(async (req, res, next) => {
  const period = String(req.body?.period || "");
  if (!MONTH.test(period)) return next(new ErrorHandler("period must be YYYY-MM", 400));
  res.json({ success: true, ...(await gstr2b.reconcile(period)) });
}));

// ── Rule 37 ────────────────────────────────────────────────────────
router.get("/itc-reversal", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await itcReversal.due(monthOf(req.query.month))) });
}));

const itcAction = (fn, code) => catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Bill not found", 404));
  const month = String(req.body?.month || "");
  if (!MONTH.test(month)) return next(new ErrorHandler("month must be YYYY-MM", 400));
  try {
    // Not held by the books lock: a step is a figure for that month's
    // GSTR-3B kept on the bill, worked out after the month's books have
    // closed and gone to Tally, and it changes nothing that went there.
    const r = await fn(req.params.id, { month, by: req.user, fingerprint: fp(code, { _id: req.params.id }, req, { month }) });
    res.json({ success: true, ...r });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    if (err.status) return next(new ErrorHandler(err.message, err.status));
    throw err;
  }
});
router.post("/bills/:id/itc-reverse", itcAction(itcReversal.reverse, ACTION_CODES.ITC_REVERSED));
router.post("/bills/:id/itc-reclaim", itcAction(itcReversal.reclaim, ACTION_CODES.ITC_RECLAIMED));

// ── GSTR-1 ─────────────────────────────────────────────────────────
router.get("/gstr1", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await gstr1.build(monthOf(req.query.month))) });
}));

router.get("/gstr1/json", catchAsyncErrors(async (req, res) => {
  const r = await gstr1.build(monthOf(req.query.month));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="GSTR1_${r.gstin || "returns"}_${r.fp}.json"`);
  res.send(JSON.stringify(gstr1.toJson(r), null, 2));
}));

router.get("/gstr1/xlsx", catchAsyncErrors(async (req, res) => {
  const r = await gstr1.build(monthOf(req.query.month));
  const wb = new ExcelJS.Workbook();
  const inv = (ws, groups, withGstin) => {
    ws.addRow([...(withGstin ? ["GSTIN", "Customer"] : []), "Invoice", "Date", "Value", "Place of supply", "Rate", "Taxable", "IGST", "CGST", "SGST", "IRN"]).font = { bold: true };
    for (const g of groups) for (const i of g.inv) for (const it of i.itms) ws.addRow([...(withGstin ? [g.ctin, g.name] : []), i.inum, i.idt, i.val, i.pos, it.itm_det.rt, it.itm_det.txval, it.itm_det.iamt, it.itm_det.camt, it.itm_det.samt, i.irn || ""]);
  };
  const b2b = wb.addWorksheet("B2B"); inv(b2b, r.b2b, true); money(b2b, [5, 8, 9, 10, 11]);
  const b2cl = wb.addWorksheet("B2CL"); inv(b2cl, r.b2cl, false); money(b2cl, [3, 6, 7, 8, 9]);
  const b2cs = wb.addWorksheet("B2CS");
  b2cs.addRow(["Type", "Place of supply", "Rate", "Taxable", "IGST", "CGST", "SGST", "Invoices"]).font = { bold: true };
  for (const g of r.b2cs) b2cs.addRow([g.sply_ty, g.pos, g.rt, g.txval, g.iamt, g.camt, g.samt, g.count]);
  money(b2cs, [4, 5, 6, 7]);
  const cdn = wb.addWorksheet("CDNR-CDNUR");
  cdn.addRow(["GSTIN", "Party", "Note", "Date", "Type", "Against", "Value", "Place of supply", "Rate", "Taxable", "IGST", "CGST", "SGST", "Reason"]).font = { bold: true };
  for (const g of r.cdnr) for (const n of g.nt) for (const it of n.itms) cdn.addRow([g.ctin, g.name, n.nt_num, n.nt_dt, n.ntty === "C" ? "Credit" : "Debit", n.against, n.val, n.pos, it.itm_det.rt, it.itm_det.txval, it.itm_det.iamt, it.itm_det.camt, it.itm_det.samt, n.reason]);
  for (const n of r.cdnur) for (const it of n.itms) cdn.addRow(["", n.party, n.nt_num, n.nt_dt, n.ntty === "C" ? "Credit" : "Debit", n.against, n.val, n.pos, it.itm_det.rt, it.itm_det.txval, it.itm_det.iamt, it.itm_det.camt, it.itm_det.samt, n.reason]);
  money(cdn, [7, 10, 11, 12, 13]);
  const hsn = wb.addWorksheet("HSN");
  hsn.addRow(["HSN", "Description", "UQC", "Quantity", "Rate", "Taxable", "IGST", "CGST", "SGST"]).font = { bold: true };
  for (const h of r.hsn) hsn.addRow([h.hsn_sc, h.desc, h.uqc, h.qty, h.rt, h.txval, h.iamt, h.camt, h.samt]);
  money(hsn, [6, 7, 8, 9]);
  const docs = wb.addWorksheet("Docs");
  docs.addRow(["Nature", "From", "To", "Total", "Cancelled", "Net issued"]).font = { bold: true };
  for (const d of r.docs) for (const x of d.docs) docs.addRow([d.doc_typ, x.from, x.to, x.totnum, x.cancel, x.net_issue]);
  const checks = wb.addWorksheet("Checks");
  checks.addRow(["Level", "Document", "Check"]).font = { bold: true };
  for (const c of r.checks) checks.addRow([c.level, c.doc, c.text]);
  for (const ws of wb.worksheets) { ws.views = [{ state: "frozen", ySplit: 1 }]; ws.columns.forEach((c) => { c.width = 16; }); }
  await sendXlsx(res, `GSTR-1 ${r.month}`, wb);
}));

// ── TDS ────────────────────────────────────────────────────────────
router.get("/tds/register", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await tds.register(monthOf(req.query.month))) });
}));

router.post("/tds/challans", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  let depositedOn;
  try { depositedOn = readDate(b.depositedOn, "depositedOn", null); } catch (err) { return next(err); }
  try {
    const { challan: c, replay } = await tds.addChallan({ ...b, depositedOn, account: isId(b.account) ? b.account : undefined, by: req.user?._id });
    res.status(replay ? 200 : 201).json({ success: true, challan: c, register: await tds.register(c.month), ...(replay ? { replay: true } : {}) });
  } catch (err) { if (err.status) return next(new ErrorHandler(err.message, err.status)); throw err; }
}));

router.get("/tds/26q", catchAsyncErrors(async (req, res, next) => {
  const q = ["Q1", "Q2", "Q3", "Q4"].includes(req.query.q) ? req.query.q : tds.quarterOf(new Date(Date.now() - 45 * 86_400_000));
  const r = await tds.form26q(fyOf(req.query.fy), q);
  if (req.query.format !== "xlsx") return res.json({ success: true, ...r });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("26Q");
  ws.addRow([`Form 26Q · ${r.fy} ${r.quarter} · ${dd(r.from)} to ${dd(r.to)}`]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(["Deductee", "PAN", "Section", "Date of payment", "Amount paid", "Rate %", "TDS", "Voucher", "Against", "Challan (BSR/No/Date)"]).font = { bold: true };
  for (const x of r.rows) ws.addRow([x.deductee, x.pan, x.section, dd(x.date), x.amountPaid, x.rate, x.tds, x.voucherNo, x.docs.join(", "), x.challan]);
  ws.addRow(["Total", "", "", "", r.totals.amountPaid, "", r.totals.tds]).font = { bold: true };
  ws.columns = [{ width: 30 }, { width: 13 }, { width: 9 }, { width: 14 }, { width: 15 }, { width: 8 }, { width: 13 }, { width: 18 }, { width: 24 }, { width: 28 }];
  money(ws, [5, 7]);
  const c = wb.addWorksheet("Checks");
  c.addRow(["Level", "Voucher", "Check"]).font = { bold: true };
  for (const k of r.checks) c.addRow([k.level, k.doc, k.text]);
  await sendXlsx(res, `26Q ${r.fy} ${r.quarter}`, wb);
}));

router.get("/tds/certificates", catchAsyncErrors(async (req, res) => {
  const fy = fyOf(req.query.fy);
  res.json({ success: true, fy, rows: await TdsCertificate.find({ fy }).sort({ quarter: 1, partyName: 1 }).lean() });
}));

router.post("/tds/certificates", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (!["issued", "received"].includes(b.kind)) return next(new ErrorHandler("kind must be issued or received", 400));
  const partyType = b.kind === "issued" ? "supplier" : "customer";
  if (!isId(b.party)) return next(new ErrorHandler(`Pick the ${partyType}`, 400));
  const party = await (partyType === "supplier" ? Supplier : Customer).findById(b.party).select("name").lean();
  if (!party) return next(new ErrorHandler(`${partyType} not found`, 404));
  if (!["Q1", "Q2", "Q3", "Q4"].includes(b.quarter)) return next(new ErrorHandler("quarter must be Q1–Q4", 400));
  const amount = Number(b.amount);
  if (!(amount >= 0)) return next(new ErrorHandler("amount must be 0 or more", 400));
  let on;
  try { on = readDate(b.on, "on", new Date()); } catch (err) { return next(err); }
  const data = { kind: b.kind, partyType, party: party._id, partyName: party.name, fy: fyOf(b.fy), quarter: b.quarter, certNo: String(b.certNo || "").trim().slice(0, 20), section: String(b.section || "").trim().toUpperCase(), amount: r2(amount), on, note: String(b.note || "").trim().slice(0, 200), createdBy: req.user?._id };
  // Recorded once: the same request sent twice is answered by the first
  // one's row, and a certificate number is entered once for a party,
  // quarter and section.
  const already = () => new ErrorHandler(`Certificate ${data.certNo} for ${party.name}, ${data.fy} ${data.quarter}${data.section ? `, section ${data.section}` : ""} is already recorded`, 409);
  let out;
  try {
    out = await once(TdsCertificate, b.requestId, async (id) => {
      if (data.certNo && await TdsCertificate.exists({ kind: data.kind, party: party._id, fy: data.fy, quarter: data.quarter, section: data.section, certNo: data.certNo })) throw already();
      return (await TdsCertificate.create({ ...data, requestId: id })).toObject();
    });
  } catch (err) {
    if (err?.code === 11000) return next(already());   // two saves together: the index let one in
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.status(out.replay ? 200 : 201).json({ success: true, certificate: out.doc, ...(out.replay ? { replay: true } : {}) });
}));

router.get("/tds/receivable", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await tds.receivable(fyOf(req.query.fy))) });
}));

router.post("/tds/26as", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  if (!req.file) return next(new ErrorHandler("Attach Form 26AS as CSV or Excel", 400));
  try {
    const r = await tds.upload26as({ fy: fyOf(req.body?.fy), buffer: req.file.buffer, filename: req.file.originalname, by: req.user?._id });
    res.json({ success: true, ...r, receivable: await tds.receivable(r.fy) });
  } catch (err) { if (err.status) return next(new ErrorHandler(err.message, err.status)); throw err; }
}));

router.get("/tds/194q", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await tds.purchases194q(fyOf(req.query.fy))) });
}));

// ── Payroll into the books ─────────────────────────────────────────
router.get("/payroll-books", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await payrollBooks.summary(monthOf(req.query.month))) });
}));

const payrollPost = (fn) => catchAsyncErrors(async (req, res, next) => {
  const month = String(req.body?.month || "");
  if (!MONTH.test(month)) return next(new ErrorHandler("month must be YYYY-MM", 400));
  try {
    const out = await fn(month, req);
    res.status(201).json({ success: true, journal: out.journal, summary: out.summary });
  } catch (err) { if (err instanceof ErrorHandler) return next(err); if (err.status) return next(new ErrorHandler(err.message, err.status)); throw err; }
});
router.post("/payroll-books/salary", isAdmin("admin", "accounts"), payrollPost(payrollBooks.postSalary));
router.post("/payroll-books/paid", isAdmin("admin", "accounts"), payrollPost(payrollBooks.postPaid));

router.post("/payroll-books/deposits", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  let depositedOn;
  try { depositedOn = readDate(b.depositedOn, "depositedOn", null); } catch (err) { return next(err); }
  try {
    const { deposit: d, replay } = await payrollBooks.addDeposit({ ...b, depositedOn, account: isId(b.account) ? b.account : undefined, by: req.user?._id });
    res.status(replay ? 200 : 201).json({ success: true, deposit: d, summary: await payrollBooks.summary(d.month), ...(replay ? { replay: true } : {}) });
  } catch (err) { if (err.status) return next(new ErrorHandler(err.message, err.status)); throw err; }
}));

// ── A machine's service bill, as a supplier bill to enter ──────────
router.get("/service-bills/:id/draft", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Service bill not found", 404));
  const sb = await MachineServiceBill.findById(req.params.id).select("-data").lean();
  if (!sb) return next(new ErrorHandler("Service bill not found", 404));
  if (sb.supplierBill) return res.json({ success: true, entered: sb.supplierBill, draft: null });
  // A supplier whose name matches the vendor typed on the log, if there is one.
  const supplier = sb.vendor ? await Supplier.findOne({ name: new RegExp(`^${sb.vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).select("name gstin").lean() : null;
  res.json({
    success: true, entered: null,
    draft: {
      serviceBill: sb._id, machine: sb.machine, kind: "service", supplier: supplier?._id || null, supplierName: supplier?.name || sb.vendor || "", vendor: sb.vendor || "",
      supplierBillNo: sb.billNo || "", billDate: sb.billDate || sb.createdAt, amount: sb.amount || 0, filename: sb.filename,
      lines: [{ description: sb.kind === "spare_bill" ? `Spare: ${sb.partName || "part"}` : `Machine service${sb.notes ? `: ${sb.notes.slice(0, 80)}` : ""}`, quantity: 1, rate: sb.amount || 0 }],
    },
  });
}));

// ── Credit note time limit ─────────────────────────────────────────
router.get("/credit-note-limit", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.query.invoice)) return next(new ErrorHandler("invoice is required", 400));
  const inv = await Invoice.findById(req.query.invoice).select("invoiceNumber invoiceDate").lean();
  if (!inv) return next(new ErrorHandler("Invoice not found", 404));
  res.json({ success: true, invoiceNumber: inv.invoiceNumber, ...creditNoteLimit.check(inv.invoiceDate) });
}));

module.exports = router;
