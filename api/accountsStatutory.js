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
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { ACTION_CODES } = require("../utils/fingerprint");
const { isId, readDate, fp } = require("../services/accountsHelpers");
const msme = require("../services/msme");
const gstr2b = require("../services/gstr2b");
const itcReversal = require("../services/itcReversal");
const gstr1 = require("../services/gstr1");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const MONTH = /^\d{4}-\d{2}$/;
const lastMonth = () => { const d = new Date(); const p = new Date(d.getFullYear(), d.getMonth() - 1, 1); return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`; };
const monthOf = (q) => (MONTH.test(String(q || "")) ? q : lastMonth());
const fyOf = (q) => { if (/^\d{4}-\d{2}$/.test(String(q || ""))) return q; const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String(y + 1).slice(2)}`; };
const dd = (d) => { if (!d) return ""; const t = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${p(t.getDate())}-${p(t.getMonth() + 1)}-${t.getFullYear()}`; };
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
    const r = await fn(req.params.id, { month, fingerprint: fp(code, { _id: req.params.id }, req, { month }) });
    res.json({ success: true, ...r });
  } catch (err) {
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

module.exports = router;
