"use strict";
// ══════════════════════════════════════════════════════════════════
//  REGISTERS  (inside /api/v2/accounts)
//
//    GET  /fixed-assets?fy=2026-27        the register with the year's depreciation
//    POST /fixed-assets                   add an asset
//    POST /fixed-assets/:id/dispose       sold or scrapped
//    POST /fixed-assets/depreciation      post the year's journal
//    GET  /fixed-assets/register.xlsx?fy= the register as Excel
//    GET  /closing-stock?asOf=            stock valued on a day
//    POST /closing-stock                  post it (and bring it forward)
//    GET  /budgets?fy=                    budget against actual by head
//    PUT  /budgets                        save the year's budgets
//    GET  /cost-centres?from=&to=         spend by order, machine, department
//    GET  /cost-centres/order/:id         what was bought for one order
//    GET  /confirmations?asOf=            parties with a balance and where each stands
//    POST /confirmations                  rows for the parties asked (or all)
//    GET  /confirmations/:id/letter       the letter and the statement behind it
//    POST /confirmations/:id/send         email / WhatsApp / printed
//    POST /confirmations/:id/reply        confirmed, or disputed with their figure
//    GET  /pdc?status=                    cheques held, deposited, cleared, bounced
//    POST /payments/:id/cheque            deposited / cleared / bounced
//    GET  /interest?asOf=&customer=       interest due on overdue invoices
//    GET  /interest/draft?customer=&asOf= the debit note that charges it
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const ExcelJS = require("exceljs");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAdmin } = require("../middleware/auth");
const { isId, readDate, DAY } = require("../services/accountsHelpers");
const fixedAssets = require("../services/fixedAssets");
const closingStock = require("../services/closingStock");
const budgets = require("../services/budgets");
const costCentres = require("../services/costCentres");
const FixedAsset = require("../models/FixedAsset");
const Payment = require("../models/Payment");
const confirmations = require("../services/confirmations");
const overdueInterest = require("../services/overdueInterest");
const { cancelVoucher } = require("../services/voucherCancel");
const { fp } = require("../services/accountsHelpers");
const { ACTION_CODES } = require("../utils/fingerprint");

const FY = /^\d{4}-\d{2}$/;
const fyOf = (q) => (FY.test(String(q || "")) ? q : fixedAssets.fyOf(new Date()));
const dd = (d) => { if (!d) return ""; const t = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`; };
/** A service's error to the client, anything else up the chain. */
const fail = (err, next) => { if (err instanceof ErrorHandler) return next(err); if (err?.status) return next(new ErrorHandler(err.message, err.status)); throw err; };
async function sendXlsx(res, name, wb) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\w.-]+/g, "_")}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}
const money = (ws, cols) => { for (const c of cols) ws.getColumn(c).numFmt = "#,##0.00"; };

// ── Fixed assets ───────────────────────────────────────────────────
router.get("/fixed-assets", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await fixedAssets.register(fyOf(req.query.fy))) });
}));

router.get("/fixed-assets/register.xlsx", catchAsyncErrors(async (req, res) => {
  const r = await fixedAssets.register(fyOf(req.query.fy));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Fixed assets");
  ws.addRow([`Fixed asset register ${r.fy} · Companies Act (Schedule II) and Income-tax Act (s.32)`]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(["Asset no.", "Name", "Block", "Put to use", "Cost", "Method", "Opening WDV (Cos. Act)", "Depreciation (Cos. Act)", "Closing WDV (Cos. Act)", "IT rate %", "Opening WDV (IT)", "Depreciation (IT)", "Closing WDV (IT)", "Status", "Supplier", "Bill"]).font = { bold: true };
  for (const a of r.rows) {
    const y = a.year;
    ws.addRow([a.assetNo, a.name, a.blockLabel, dd(a.putToUse), a.cost, a.method.toUpperCase(), y.companiesAct.opening, y.companiesAct.depreciation, y.companiesAct.closing, y.incomeTax.rate, y.incomeTax.opening, y.incomeTax.depreciation, y.incomeTax.closing, y.disposal ? `${a.status} ${dd(y.disposal.date)} for ${y.disposal.amount}` : a.status, a.supplierName || "", a.billNo || ""]);
  }
  ws.addRow(["Total", "", "", "", r.totals.cost, "", r.totals.caOpening, r.totals.caDep, r.totals.caClosing, "", r.totals.itOpening, r.totals.itDep, r.totals.itClosing]).font = { bold: true };
  ws.columns = [{ width: 16 }, { width: 30 }, { width: 26 }, { width: 12 }, { width: 14 }, { width: 8 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 9 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 24 }, { width: 16 }];
  money(ws, [5, 7, 8, 9, 11, 12, 13]);
  const blocks = wb.addWorksheet("By block");
  blocks.addRow(["Block", "Assets", "Cost", "Opening WDV (Cos. Act)", "Depreciation (Cos. Act)", "Closing WDV (Cos. Act)", "IT rate %", "Opening WDV (IT)", "Depreciation (IT)", "Closing WDV (IT)"]).font = { bold: true };
  for (const b of r.blocks) blocks.addRow([b.label, b.count, b.cost, b.caOpening, b.caDep, b.caClosing, b.itRate, b.itOpening, b.itDep, b.itClosing]);
  blocks.columns.forEach((c) => { c.width = 18; });
  money(blocks, [3, 4, 5, 6, 8, 9, 10]);
  await sendXlsx(res, `Fixed assets ${r.fy}`, wb);
}));

router.post("/fixed-assets", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  try {
    const out = await fixedAssets.create(req.body || {}, req);
    res.status(out.replay ? 200 : 201).json({ success: true, asset: out.asset, year: fixedAssets.schedule(out.asset, fixedAssets.fyOf(out.asset.putToUse)), ...(out.replay ? { replay: true } : {}) });
  } catch (err) { return fail(err, next); }
}));

router.post("/fixed-assets/depreciation", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  try {
    const out = await fixedAssets.postDepreciation(String(req.body?.fy || ""), req);
    res.status(201).json({ success: true, journal: out.journal, register: out.register });
  } catch (err) { return fail(err, next); }
}));

router.get("/fixed-assets/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Asset not found", 404));
  const a = await FixedAsset.findById(req.params.id).select("-attachments.data").lean();
  if (!a) return next(new ErrorHandler("Asset not found", 404));
  // Every year of its life so far, for the asset's own page.
  const years = [];
  let fy = fixedAssets.fyOf(a.putToUse);
  const last = fixedAssets.fyOf(a.disposal?.date && a.status !== "active" ? a.disposal.date : new Date());
  for (let i = 0; i < 60 && Number(fy.slice(0, 4)) <= Number(last.slice(0, 4)); i += 1) {
    const y = fixedAssets.schedule(a, fy);
    if (y) years.push(y);
    const n = Number(fy.slice(0, 4)) + 1; fy = `${n}-${String(n + 1).slice(2)}`;
  }
  res.json({ success: true, asset: a, years });
}));

router.post("/fixed-assets/:id/dispose", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  try { res.json({ success: true, ...(await fixedAssets.dispose(req.params.id, req.body || {}, req)) }); }
  catch (err) { return fail(err, next); }
}));

// ── Closing stock ──────────────────────────────────────────────────
router.get("/closing-stock", catchAsyncErrors(async (req, res, next) => {
  let asOf;
  try { asOf = readDate(req.query.asOf, "asOf", new Date()); } catch (err) { return next(err); }
  res.json({ success: true, ...(await closingStock.value(asOf)) });
}));

router.post("/closing-stock", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  let asOf;
  try { asOf = readDate(req.body?.asOf, "asOf", null); } catch (err) { return next(err); }
  if (!asOf) return next(new ErrorHandler("asOf is required (YYYY-MM-DD)", 400));
  if (asOf > new Date()) return next(new ErrorHandler("Stock cannot be valued on a day that has not come", 400));
  try { res.status(201).json({ success: true, ...(await closingStock.post(asOf, req)) }); }
  catch (err) { return fail(err, next); }
}));

// ── Budgets ────────────────────────────────────────────────────────
router.get("/budgets", catchAsyncErrors(async (req, res, next) => {
  try { res.json({ success: true, ...(await budgets.compare(fyOf(req.query.fy))) }); }
  catch (err) { return fail(err, next); }
}));

router.put("/budgets", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const fy = String(req.body?.fy || "");
  try {
    await budgets.save(fy, req.body?.rows, req.user?._id);
    res.json({ success: true, ...(await budgets.compare(fy)) });
  } catch (err) { return fail(err, next); }
}));

// ── Cost centres ───────────────────────────────────────────────────
router.get("/cost-centres", catchAsyncErrors(async (req, res, next) => {
  let from, to;
  try {
    const now = new Date();
    from = readDate(req.query.from, "from", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    to = readDate(req.query.to, "to", now);
  } catch (err) { return next(err); }
  res.json({ success: true, ...(await costCentres.report({ from, to: new Date(to.getTime() + DAY - 1) })) });
}));

router.get("/cost-centres/order/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Order not found", 404));
  res.json({ success: true, ...(await costCentres.forOrder(req.params.id)) });
}));

// ── Balance confirmations ──────────────────────────────────────────
router.get("/confirmations", catchAsyncErrors(async (req, res, next) => {
  let asOf;
  try { asOf = readDate(req.query.asOf, "asOf", new Date()); } catch (err) { return next(err); }
  res.json({ success: true, ...(await confirmations.list(asOf)) });
}));

router.post("/confirmations", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  let asOf;
  try { asOf = readDate(b.asOf, "asOf", null); } catch (err) { return next(err); }
  if (!asOf) return next(new ErrorHandler("asOf is required (YYYY-MM-DD)", 400));
  try {
    const out = await confirmations.create({ asOf, partyType: b.partyType, parties: b.parties, all: !!b.all }, req);
    res.status(201).json({ success: true, ...out, ...(await confirmations.list(asOf)) });
  } catch (err) { return fail(err, next); }
}));

router.get("/confirmations/:id/letter", catchAsyncErrors(async (req, res, next) => {
  try { res.json({ success: true, ...(await confirmations.letter(req.params.id)) }); }
  catch (err) { return fail(err, next); }
}));

router.post("/confirmations/:id/send", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  try { res.json({ success: true, confirmation: await confirmations.send(req.params.id, req.body || {}, req) }); }
  catch (err) { return fail(err, next); }
}));

router.post("/confirmations/:id/reply", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  try { res.json({ success: true, confirmation: await confirmations.reply(req.params.id, req.body || {}, req) }); }
  catch (err) { return fail(err, next); }
}));

// ── Post-dated cheques ─────────────────────────────────────────────
router.get("/pdc", catchAsyncErrors(async (req, res) => {
  const status = ["held", "deposited", "cleared", "bounced", "all"].includes(req.query.status) ? req.query.status : "held";
  const q = { mode: "cheque", "cheque.status": status === "all" ? { $in: ["held", "deposited", "cleared", "bounced"] } : status };
  if (status !== "bounced") q.status = "posted";
  const rows = await Payment.find(q).select("kind voucherNo date partyType customer supplier partyName amount account accountName reference cheque allocations.docNo status cancel").sort({ "cheque.date": 1, date: 1 }).limit(500).lean();
  const today = new Date(); today.setUTCHours(23, 59, 59, 999);
  const inWeek = new Date(today.getTime() + 7 * DAY);
  const held = await Payment.find({ status: "posted", "cheque.status": "held" }).select("kind amount cheque.date").lean();
  const sum = (xs) => Math.round(xs.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  res.json({
    success: true, status, rows,
    totals: {
      held: { count: held.length, received: sum(held.filter((x) => x.kind === "receipt")), issued: sum(held.filter((x) => x.kind === "payment")) },
      dueToday: { count: held.filter((x) => new Date(x.cheque.date) <= today).length, amount: sum(held.filter((x) => new Date(x.cheque.date) <= today)) },
      dueThisWeek: { count: held.filter((x) => new Date(x.cheque.date) <= inWeek).length, amount: sum(held.filter((x) => new Date(x.cheque.date) <= inWeek)) },
    },
  });
}));

router.post("/payments/:id/cheque", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Voucher not found", 404));
  const v = await Payment.findById(req.params.id).lean();
  if (!v) return next(new ErrorHandler("Voucher not found", 404));
  if (v.mode !== "cheque" || !v.cheque?.status) return next(new ErrorHandler("That voucher is not a cheque", 400));
  const b = req.body || {};
  const action = ["deposited", "cleared", "bounced"].includes(b.action) ? b.action : null;
  if (!action) return next(new ErrorHandler("action must be deposited, cleared or bounced", 400));
  let on;
  try { on = readDate(b.on, "on", new Date()); } catch (err) { return next(err); }
  const from = v.cheque.status;
  const allowed = { deposited: ["held"], cleared: ["held", "deposited"], bounced: ["held", "deposited"] };
  if (!allowed[action].includes(from)) return next(new ErrorHandler(`A ${from} cheque cannot be marked ${action}`, 409));
  if (v.status !== "posted") return next(new ErrorHandler("That voucher is cancelled", 409));
  const meta = { voucherNo: v.voucherNo, cheque: v.cheque.number, from, to: action, on };
  if (action === "bounced") {
    const reason = String(b.reason || "").trim().slice(0, 200);
    if (reason.length < 3) return next(new ErrorHandler("Say why the cheque was returned", 400));
    const charges = Math.max(0, Math.round((Number(b.charges) || 0) * 100) / 100);
    try {
      const payment = await cancelVoucher(v, `Cheque ${v.cheque.number || ""} returned: ${reason}`.trim(), req, {
        extra: { "cheque.status": "bounced", "cheque.bouncedOn": on, "cheque.bounceReason": reason, "cheque.charges": charges },
        code: ACTION_CODES.PDC_UPDATED, meta: { ...meta, reason, charges },
      });
      return res.json({ success: true, payment, bounced: true });
    } catch (err) { return fail(err, next); }
  }
  const set = action === "deposited" ? { "cheque.status": "deposited", "cheque.depositedOn": on } : { "cheque.status": "cleared", clearedOn: on, ...(from === "held" ? { "cheque.depositedOn": on } : {}) };
  await Payment.updateOne({ _id: v._id }, { $set: set, $push: { fingerprints: fp(ACTION_CODES.PDC_UPDATED, v, req, meta) } });
  res.json({ success: true, payment: await Payment.findById(v._id).select("-attachments.data").lean() });
}));

// ── Interest on overdue receivables ────────────────────────────────
router.get("/interest", catchAsyncErrors(async (req, res, next) => {
  let asOf;
  try { asOf = readDate(req.query.asOf, "asOf", new Date()); } catch (err) { return next(err); }
  res.json({ success: true, ...(await overdueInterest.compute({ asOf, customer: isId(req.query.customer) ? req.query.customer : undefined })) });
}));

router.get("/interest/draft", catchAsyncErrors(async (req, res, next) => {
  let asOf;
  try { asOf = readDate(req.query.asOf, "asOf", new Date()); } catch (err) { return next(err); }
  try { res.json({ success: true, ...(await overdueInterest.draft({ customer: req.query.customer, asOf })) }); }
  catch (err) { return fail(err, next); }
}));

module.exports = router;
