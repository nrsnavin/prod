"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — THE BOOKS SIDE  (mounted inside /api/v2/accounts)
//
//    Contras          /contras            money between our own accounts
//    Opening balances /opening-balances   what parties owed on day one,
//                                         typed in or imported from Tally
//    Settings         /settings           lock date, Tally ledger names,
//                                         bill rate tolerance
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const mongoose = require("mongoose");
const multer   = require("multer");
const ExcelJS  = require("exceljs");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAdmin }      = require("../middleware/auth");
const { keepRequestContext } = require("../middleware/userContext");
const { escapeRegex }  = require("../utils/escapeRegex");
const { ACTION_CODES } = require("../utils/fingerprint");
const { allocate }     = require("../services/docNumbers");
const partyLedger      = require("../services/partyLedger");
const { assertOpen, getSettings } = require("../services/booksLock");
const { isId, r2, readDate, reasonFrom, fp, withTxn, paging, DAY } = require("../services/accountsHelpers");
const { parseCsv, parseDate } = require("../services/bankStatement");

const BankAccount      = require("../models/BankAccount");
const Contra           = require("../models/Contra");
const OpeningBalance   = require("../models/OpeningBalance");
const AccountsSettings = require("../models/AccountsSettings");
const Customer         = require("../models/Customer");
const Supplier         = require("../models/Supplier");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// ══════════════════════════════════════════════════════════════════
//  CONTRAS
// ══════════════════════════════════════════════════════════════════
router.get("/contras", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.account)) q.$or = [{ from: req.query.account }, { to: req.query.account }];
  if (range) q.date = range;
  const [total, contras] = await Promise.all([
    Contra.countDocuments(q),
    Contra.find(q).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), contras });
}));

router.get("/contras/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Contra not found", 404));
  const contra = await Contra.findById(req.params.id).lean();
  if (!contra) return next(new ErrorHandler("Contra not found", 404));
  res.json({ success: true, contra });
}));

router.post("/contras", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (b.requestId) {
    const dup = await Contra.findOne({ requestId: String(b.requestId) }).lean();
    if (dup) return res.json({ success: true, contra: dup, replay: true });
  }
  if (!isId(b.from) || !isId(b.to)) return next(new ErrorHandler("Pick the account the money left and the one it went to", 400));
  if (String(b.from) === String(b.to)) return next(new ErrorHandler("The two accounts must differ", 400));
  const [from, to] = await Promise.all([BankAccount.findById(b.from).lean(), BankAccount.findById(b.to).lean()]);
  if (!from || !from.active || !to || !to.active) return next(new ErrorHandler("Account not found", 404));
  const amount = r2(b.amount);
  if (!(amount > 0)) return next(new ErrorHandler("amount must be more than 0", 400));
  let date;
  try { date = readDate(b.date, "date", new Date()); await assertOpen(date, req); } catch (err) { return next(err); }
  const mode = ["cash", "bank", "upi", "cheque", "card"].includes(b.mode) ? b.mode : from.kind === "cash" || to.kind === "cash" ? "cash" : "bank";
  const { financialYear, sequence, number } = await allocate(Contra, "CTR", { at: date });
  const _id = new mongoose.Types.ObjectId();
  try {
    await Contra.create({
      _id, contraNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
      from: from._id, fromName: from.name, to: to._id, toName: to.name, amount, mode,
      reference: String(b.reference || "").trim().slice(0, 60), narration: String(b.narration || "").trim().slice(0, 300),
      createdBy: req.user?._id,
      fingerprints: [fp(ACTION_CODES.CONTRA_POSTED, { _id }, req, { contraNo: number, from: from.name, to: to.name, amount })],
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await Contra.findOne({ requestId: String(b.requestId) }).lean();
      if (dup) return res.json({ success: true, contra: dup, replay: true });
    }
    throw err;
  }
  res.status(201).json({ success: true, contra: await Contra.findById(_id).lean() });
}));

// ── Journal vouchers ───────────────────────────────────────────────
const Journal = require("../models/Journal");
const journals = require("../services/journals");

router.get("/journals", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (req.query.purpose && req.query.purpose !== "all") q.purpose = String(req.query.purpose);
  if (isId(req.query.party)) q.$or = [{ "lines.customer": req.query.party }, { "lines.supplier": req.query.party }];
  if (range) q.date = range;
  if (req.query.search) { const re = new RegExp(escapeRegex(String(req.query.search)), "i"); q.$and = [{ $or: [{ journalNo: re }, { narration: re }, { reason: re }, { "lines.ledger": re }] }]; }
  const [total, rows] = await Promise.all([
    Journal.countDocuments(q),
    Journal.find(q).select("-fingerprints").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), journals: rows });
}));

router.get("/journals/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Journal not found", 404));
  const journal = await Journal.findById(req.params.id).lean();
  if (!journal) return next(new ErrorHandler("Journal not found", 404));
  res.json({ success: true, journal });
}));

router.post("/journals", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  let date, read;
  try {
    date = readDate(b.date, "date", new Date());
    await assertOpen(date, req);
    if (String(b.reason || "").trim().length < 8) throw new ErrorHandler("Say why (a reason of at least 8 characters)", 400);
    read = await journals.read(b);
    const limit = (await getSettings()).journals?.approvalAbove || 0;
    if (limit > 0 && read.total > limit && req.user?.role !== "admin") throw new ErrorHandler(`A journal above ₹${limit.toLocaleString("en-IN")} needs an admin to post it`, 403);
  } catch (err) { return next(err); }
  let out;
  try {
    out = await journals.post({ date, purpose: ["setoff", "writeoff", "accrual", "salary", "depreciation", "stock", "reclass", "other"].includes(b.purpose) ? b.purpose : "other", narration: b.narration, reason: b.reason, lines: read.lines, total: read.total, requestId: b.requestId }, req);
  } catch (err) { if (err instanceof ErrorHandler) return next(err); throw err; }
  res.status(out.replay ? 200 : 201).json({ success: true, journal: out.journal, ...(out.replay ? { replay: true } : {}) });
}));

router.post("/journals/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Journal not found", 404));
  const j = await Journal.findById(req.params.id).lean();
  if (!j) return next(new ErrorHandler("Journal not found", 404));
  if (j.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(j.date, req, { cancelling: true }); await journals.cancel(j, reason, req); } catch (err) { if (err instanceof ErrorHandler) return next(err); throw err; }
  res.json({ success: true, journal: await Journal.findById(j._id).lean() });
}));

router.post("/contras/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Contra not found", 404));
  const c = await Contra.findById(req.params.id).lean();
  if (!c) return next(new ErrorHandler("Contra not found", 404));
  if (c.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(c.date, req, { cancelling: true }); } catch (err) { return next(err); }
  await Contra.updateOne({ _id: c._id, status: "posted" }, {
    $set: { status: "cancelled", cancel: { reason, at: new Date(), by: req.user?._id } },
    $push: { fingerprints: fp(ACTION_CODES.CONTRA_CANCELLED, c, req, { contraNo: c.contraNo, reason }) },
  });
  res.json({ success: true, contra: await Contra.findById(c._id).lean() });
}));

// ══════════════════════════════════════════════════════════════════
//  OPENING BALANCES
// ══════════════════════════════════════════════════════════════════
router.get("/opening-balances", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip } = paging(req);
  const q = {};
  if (req.query.partyType === "customer" || req.query.partyType === "supplier") q.partyType = req.query.partyType;
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.party)) q.$or = [{ customer: req.query.party }, { supplier: req.query.party }];
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$and = [{ $or: [{ docNo: re }, { partyName: re }, { refNo: re }] }];
  }
  const [total, rows, sums] = await Promise.all([
    OpeningBalance.countDocuments(q),
    OpeningBalance.find(q).sort({ partyName: 1, date: 1 }).skip(skip).limit(limit).lean(),
    OpeningBalance.aggregate([
      { $match: { status: "posted" } },
      { $group: { _id: { partyType: "$partyType", kind: "$kind" }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);
  const totals = { customer: { due: 0, advance: 0 }, supplier: { due: 0, advance: 0 } };
  for (const s of sums) totals[s._id.partyType][s._id.kind] = r2(s.amount);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), rows, totals });
}));

/**
 * Check one opening balance row and resolve its party. Throws ErrorHandler.
 * row: { partyType, party, kind, refNo, date, dueDate, amount, notes }
 */
async function readOpening(row, i = 0) {
  const at = i ? `Row ${i}: ` : "";
  const partyType = row.partyType === "supplier" ? "supplier" : row.partyType === "customer" ? "customer" : null;
  if (!partyType) throw new ErrorHandler(`${at}partyType must be customer or supplier`, 400);
  if (!isId(row.party)) throw new ErrorHandler(`${at}party is required`, 400);
  const party = await (partyType === "customer" ? Customer : Supplier).findById(row.party).select("name paymentTerms paymentTermsDays").lean();
  if (!party) throw new ErrorHandler(`${at}${partyType} not found`, 404);
  const kind = row.kind === "advance" ? "advance" : "due";
  const amount = r2(row.amount);
  if (!(amount > 0)) throw new ErrorHandler(`${at}amount must be more than 0`, 400);
  const date = readDate(row.date, `${at}date`);
  if (!date) throw new ErrorHandler(`${at}date is required`, 400);
  const terms = partyType === "customer" ? parseInt(party.paymentTerms, 10) || 0 : party.paymentTermsDays ?? 30;
  const dueDate = kind === "due" ? readDate(row.dueDate, `${at}dueDate`, new Date(date.getTime() + terms * DAY)) : undefined;
  return { partyType, party, kind, amount, date, dueDate, refNo: String(row.refNo || "").trim().slice(0, 40), notes: String(row.notes || "").trim().slice(0, 300) };
}

async function postOpening(o, req, { importBatch = "", requestId } = {}) {
  const { financialYear, sequence, number } = await allocate(OpeningBalance, "OB", { at: o.date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, docNo: number, financialYear, sequence, requestId: requestId ? String(requestId) : undefined,
    partyType: o.partyType, customer: o.partyType === "customer" ? o.party._id : undefined, supplier: o.partyType === "supplier" ? o.party._id : undefined,
    partyName: o.party.name, kind: o.kind, refNo: o.refNo, date: o.date, dueDate: o.dueDate, amount: o.amount,
    settledAmount: 0, unapplied: o.kind === "advance" ? o.amount : 0, notes: o.notes, importBatch, createdBy: req.user?._id,
    fingerprints: [fp(ACTION_CODES.OPENING_POSTED, { _id }, req, { docNo: number, party: o.party.name, kind: o.kind, amount: o.amount })],
  };
  await withTxn(async (session) => {
    await OpeningBalance.create([data], { session });
    await partyLedger.post(partyLedger.openingEntry(data), session);
  });
  return OpeningBalance.findById(_id).lean();
}

router.post("/opening-balances", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (b.requestId) {
    const dup = await OpeningBalance.findOne({ requestId: String(b.requestId) }).lean();
    if (dup) return res.json({ success: true, row: dup, replay: true });
  }
  let o;
  try { o = await readOpening(b); await assertOpen(o.date, req); } catch (err) { return next(err); }
  res.status(201).json({ success: true, row: await postOpening(o, req, { requestId: b.requestId }) });
}));

router.post("/opening-balances/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const o = await OpeningBalance.findById(req.params.id).lean();
  if (!o) return next(new ErrorHandler("Not found", 404));
  if (o.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  if ((o.settledAmount || 0) > 0 || (o.applications || []).length) return next(new ErrorHandler("Something is already set against this balance — cancel that first", 409));
  const refundedBy = await require("../models/Payment").findOne({ status: "posted", "refunds.source": o._id }).select("voucherNo").lean();
  if (refundedBy) return next(new ErrorHandler(`${o.docNo} was refunded by ${refundedBy.voucherNo} — cancel that first`, 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(o.date, req, { cancelling: true }); } catch (err) { return next(err); }
  await withTxn(async (session) => {
    const r = await OpeningBalance.updateOne({ _id: o._id, status: "posted", settledAmount: { $lte: 0 }, "applications.0": { $exists: false } }, {
      $set: { status: "cancelled", unapplied: 0, cancel: { reason, at: new Date(), by: req.user?._id } },
      $push: { fingerprints: fp(ACTION_CODES.OPENING_CANCELLED, o, req, { docNo: o.docNo, reason }) },
    }, { session });
    if (r.matchedCount === 0) throw new ErrorHandler("Something was set against this balance meanwhile", 409);
    await partyLedger.reverse("OpeningBalance", o._id, session);
  });
  res.json({ success: true, row: await OpeningBalance.findById(o._id).lean() });
}));

// ── Import from a Tally (or any) spreadsheet ───────────────────────
//  Columns, by header (any order, any case): Type (Customer/Supplier),
//  Party (name), GSTIN, Ref / Bill no, Date, Due date, Amount, Dr/Cr.
//  For a customer Dr is owed to us and Cr an advance; for a supplier Cr
//  is owed by us and Dr an advance. A negative amount flips the side.
async function tableOf(file) {
  if (/spreadsheetml|excel/.test(file.mimetype || "") || /\.xlsx?$/i.test(file.originalname || "")) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets[0];
    const rows = [];
    ws?.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value;
        cells[col - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === "object" && "result" in v ? v.result : v && typeof v === "object" && "richText" in v ? v.richText.map((t) => t.text).join("") : v;
      });
      rows.push(cells.map((c) => (c == null ? "" : String(c))));
    });
    return rows;
  }
  return parseCsv(file.buffer.toString("utf8").replace(/^﻿/, ""));
}

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

router.post("/opening-balances/import", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  if (!req.file) return next(new ErrorHandler("Attach the balances as Excel or CSV", 400));
  const table = await tableOf(req.file);
  let at = -1;
  let col = null;
  for (let i = 0; i < Math.min(table.length, 20); i++) {
    const h = table[i].map((x) => String(x || "").trim().toLowerCase());
    const find = (re) => h.findIndex((x) => re.test(x));
    const c = { type: find(/^type|party type|group/), party: find(/^party|^name|ledger|customer|supplier/), gstin: find(/gstin|gst no/), ref: find(/ref|bill|invoice|voucher/), date: find(/^date|bill date|invoice date/), due: find(/due/), amount: find(/amount|balance|pending/), drcr: find(/dr\s*\/?\s*cr|side|^dr$|^cr$/) };
    if (c.party >= 0 && c.amount >= 0 && c.party !== c.amount) { at = i; col = c; break; }
  }
  if (!col) return next(new ErrorHandler("Could not find the Party and Amount columns. Use the template: Type, Party, GSTIN, Ref, Date, Due date, Amount, Dr/Cr.", 400));
  const [customers, suppliers] = await Promise.all([Customer.find({}).select("name gstin").lean(), Supplier.find({}).select("name gstin").lean()]);
  const byName = { customer: new Map(customers.map((c) => [norm(c.name), c])), supplier: new Map(suppliers.map((s) => [norm(s.name), s])) };
  const byGstin = { customer: new Map(customers.filter((c) => c.gstin).map((c) => [norm(c.gstin), c])), supplier: new Map(suppliers.filter((s) => s.gstin).map((s) => [norm(s.gstin), s])) };
  const rows = [];
  for (let i = at + 1; i < table.length; i++) {
    const r = table[i];
    const name = String(r[col.party] || "").trim();
    if (!name) continue;
    const rawAmount = Number(String(r[col.amount] || "").replace(/[,₹\s]/g, "").replace(/(dr|cr)$/i, ""));
    if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;
    const typeText = col.type >= 0 ? String(r[col.type] || "").toLowerCase() : "";
    const sideText = (col.drcr >= 0 ? String(r[col.drcr] || "") : String(r[col.amount] || "").match(/(dr|cr)\s*$/i)?.[1] || "").trim().toLowerCase();
    const gstin = col.gstin >= 0 ? norm(r[col.gstin]) : "";
    // The party: a stated type first, else wherever the name or GSTIN is on file.
    let partyType = /supp|credit|vendor/.test(typeText) ? "supplier" : /cust|debt|buyer/.test(typeText) ? "customer" : null;
    const look = (t) => (gstin && byGstin[t].get(gstin)) || byName[t].get(norm(name)) || null;
    let party = partyType ? look(partyType) : null;
    if (!partyType) {
      const c = look("customer"); const s = look("supplier");
      if (c && !s) { partyType = "customer"; party = c; } else if (s && !c) { partyType = "supplier"; party = s; }
    }
    // Dr on a customer / Cr on a supplier is owed; the other side an advance.
    let side = sideText.startsWith("d") ? "dr" : sideText.startsWith("c") ? "cr" : partyType === "supplier" ? "cr" : "dr";
    if (rawAmount < 0) side = side === "dr" ? "cr" : "dr";
    const kind = partyType ? ((partyType === "customer") === (side === "dr") ? "due" : "advance") : null;
    const date = col.date >= 0 ? parseDate(r[col.date]) : null;
    const due = col.due >= 0 ? parseDate(r[col.due]) : null;
    const problem = !partyType ? `"${name}" is not a customer or supplier on file${typeText ? "" : " (or is both — add a Type column)"}` : !party ? `No ${partyType} named "${name}" on file` : null;
    rows.push({
      line: i + 1, partyType, party: party?._id || null, partyName: party?.name || name, refNo: col.ref >= 0 ? String(r[col.ref] || "").trim().slice(0, 40) : "",
      date: date ? date.toISOString().slice(0, 10) : null, dueDate: due ? due.toISOString().slice(0, 10) : null, amount: r2(Math.abs(rawAmount)), kind, problem,
    });
  }
  if (!rows.length) return next(new ErrorHandler("No balances found in the file", 400));
  res.json({ success: true, rows, file: req.file.originalname, ok: rows.filter((r) => !r.problem).length, problems: rows.filter((r) => r.problem).length });
}));

/** The rows the person confirmed, posted one by one; each says how it went. */
router.post("/opening-balances/bulk", catchAsyncErrors(async (req, res, next) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return next(new ErrorHandler("No rows to post", 400));
  if (rows.length > 1000) return next(new ErrorHandler("At most 1000 rows at a time", 400));
  const fallbackDate = readDate(req.body?.asOn, "asOn", null);
  const importBatch = `import:${Date.now().toString(36)}`;
  const results = [];
  for (const [i, raw] of rows.entries()) {
    try {
      const o = await readOpening({ ...raw, date: raw.date || fallbackDate }, i + 1);
      await assertOpen(o.date, req);
      const requestId = raw.requestId ? String(raw.requestId) : undefined;
      if (requestId) {
        const dup = await OpeningBalance.findOne({ requestId }).lean();
        if (dup) { results.push({ index: i, ok: true, docNo: dup.docNo, replay: true }); continue; }
      }
      const row = await postOpening(o, req, { importBatch, requestId });
      results.push({ index: i, ok: true, docNo: row.docNo });
    } catch (err) {
      results.push({ index: i, ok: false, error: err.message });
    }
  }
  res.json({ success: true, results, posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, importBatch });
}));

router.get("/opening-balances/template.xlsx", catchAsyncErrors(async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Opening balances");
  ws.columns = [
    { header: "Type", key: "type", width: 12 }, { header: "Party", key: "party", width: 34 }, { header: "GSTIN", key: "gstin", width: 18 },
    { header: "Ref", key: "ref", width: 16 }, { header: "Date", key: "date", width: 12 }, { header: "Due date", key: "due", width: 12 },
    { header: "Amount", key: "amount", width: 14 }, { header: "Dr/Cr", key: "drcr", width: 8 },
  ];
  ws.addRow({ type: "Customer", party: "Sunrise Garments", gstin: "", ref: "INV-1182", date: "2026-03-12", due: "2026-04-11", amount: 48500, drcr: "Dr" });
  ws.addRow({ type: "Supplier", party: "Sri Yarn Traders", gstin: "", ref: "SY/0998", date: "2026-03-20", due: "", amount: 32150, drcr: "Cr" });
  ws.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="opening-balances-template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

// ── Set once, from the dashboard (services/openingOnboarding.js) ──
const onboarding = require("../services/openingOnboarding");
const whoName = (req) => req.user?.name || req.user?.username || "";

router.get("/opening-onboarding", catchAsyncErrors(async (req, res) => {
  const partyType = req.query.partyType === "customer" || req.query.partyType === "supplier" ? req.query.partyType : "";
  res.json({ success: true, ...(await onboarding.status({ partyType, search: req.query.search, limit: req.query.limit, by: whoName(req) })) });
}));

router.put("/opening-onboarding", catchAsyncErrors(async (req, res, next) => {
  let asOn;
  try { asOn = readDate(req.body?.asOn, "asOn"); } catch (err) { return next(err); }
  if (!asOn) return next(new ErrorHandler("asOn is required", 400));
  if (asOn > new Date()) return next(new ErrorHandler("The balances are as on a day already past", 400));
  await onboarding.setAsOn(asOn);
  res.json({ success: true, asOn: asOn.toISOString().slice(0, 10) });
}));

/** Checked, and nothing was owed either way. */
router.post("/opening-onboarding/none", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.body?.partyType === "supplier" ? "supplier" : req.body?.partyType === "customer" ? "customer" : null;
  if (!partyType) return next(new ErrorHandler("partyType must be customer or supplier", 400));
  if (!isId(req.body?.party)) return next(new ErrorHandler("party is required", 400));
  const party = await (partyType === "customer" ? Customer : Supplier).findById(req.body.party).select("name").lean();
  if (!party) return next(new ErrorHandler(`${partyType} not found`, 404));
  await onboarding.markNone(partyType, party, req.user);
  res.json({ success: true });
}));

/** An admin stops it, with parties still left. */
router.post("/opening-onboarding/close", isAdmin("admin"), catchAsyncErrors(async (req, res) => {
  res.json({ success: true, left: await onboarding.close(req.user) });
}));

// ══════════════════════════════════════════════════════════════════
//  SETTINGS AND THE LOCK
// ══════════════════════════════════════════════════════════════════
/** Settings as the screens see them: the connector's key hash never leaves the server. */
const publicSettings = (s) => { if (!s) return s; const { connector, ...rest } = s; return { ...rest, connector: { configured: !!connector?.keyHash, lastSeenAt: connector?.lastSeenAt || null } }; };

router.get("/settings", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, settings: publicSettings(await getSettings()) });
}));

router.put("/settings", isAdmin("admin"), catchAsyncErrors(async (req, res) => {
  const b = req.body || {};
  const set = {};
  for (const [k, v] of Object.entries(b.tally || {})) {
    if (AccountsSettings.schema.path(`tally.${k}`)) set[`tally.${k}`] = String(v ?? "").trim().slice(0, 80);
  }
  if (b.bills?.rateVariancePercent !== undefined) {
    const p = Number(b.bills.rateVariancePercent);
    if (Number.isFinite(p) && p >= 0 && p <= 100) set["bills.rateVariancePercent"] = p;
  }
  if (b.gst?.hsnDigits !== undefined && [4, 6, 8].includes(Number(b.gst.hsnDigits))) set["gst.hsnDigits"] = Number(b.gst.hsnDigits);
  if (b.tds?.purchase194q !== undefined) {
    const q = b.tds.purchase194q || {};
    if (q.enabled !== undefined) set["tds.purchase194q.enabled"] = !!q.enabled;
    if (Number.isFinite(Number(q.limit)) && Number(q.limit) >= 0) set["tds.purchase194q.limit"] = Number(q.limit);
    if (Number.isFinite(Number(q.rate)) && Number(q.rate) >= 0 && Number(q.rate) <= 100) set["tds.purchase194q.rate"] = Number(q.rate);
  }
  if (b.journals?.approvalAbove !== undefined) {
    const p = Number(b.journals.approvalAbove);
    if (Number.isFinite(p) && p >= 0) set["journals.approvalAbove"] = p;
  }
  if (b.costCentres?.tally !== undefined) set["costCentres.tally"] = !!b.costCentres.tally;
  if (b.receivables) {
    const r = b.receivables;
    if (r.interestRate !== undefined && Number.isFinite(Number(r.interestRate)) && Number(r.interestRate) >= 0 && Number(r.interestRate) <= 100) set["receivables.interestRate"] = Number(r.interestRate);
    if (r.graceDays !== undefined && Number.isInteger(Number(r.graceDays)) && Number(r.graceDays) >= 0 && Number(r.graceDays) <= 365) set["receivables.graceDays"] = Number(r.graceDays);
  }
  if (b.collections) {
    const c = b.collections;
    if (c.acknowledgeReplies !== undefined) set["collections.acknowledgeReplies"] = !!c.acknowledgeReplies;
    // Answer customers on WhatsApp (services/customerAssistant.js).
    if (c.assistant !== undefined) set["collections.assistant"] = !!c.assistant;
    const a = c.autoRemind || {};
    if (a.enabled !== undefined) set["collections.autoRemind.enabled"] = !!a.enabled;
    for (const [k, lo, hi] of [["hour", 0, 23], ["everyDays", 1, 60], ["minOverdueDays", 0, 365]]) {
      if (a[k] !== undefined && Number.isInteger(Number(a[k])) && Number(a[k]) >= lo && Number(a[k]) <= hi) set[`collections.autoRemind.${k}`] = Number(a[k]);
    }
  }
  if (b.lut) {
    if (b.lut.number !== undefined) set["lut.number"] = String(b.lut.number || "").trim().toUpperCase().slice(0, 40);
    for (const k of ["validFrom", "validTo"]) {
      if (b.lut[k] === undefined) continue;
      if (!b.lut[k]) { set[`lut.${k}`] = null; continue; }
      const d = new Date(b.lut[k]);
      if (!Number.isNaN(d.getTime())) set[`lut.${k}`] = d;
    }
  }
  await getSettings();
  const settings = await AccountsSettings.findOneAndUpdate({ key: "accounts" }, { $set: set }, { new: true }).lean();
  res.json({ success: true, settings: publicSettings(settings) });
}));

/** Close the books up to a date (or reopen: lockDate null). Admin only. */
router.post("/lock", isAdmin("admin"), catchAsyncErrors(async (req, res, next) => {
  let lockDate = null;
  try { lockDate = readDate(req.body?.lockDate, "lockDate", null); } catch (err) { return next(err); }
  const current = (await getSettings()).lockDate;
  if (current && (!lockDate || lockDate < current) && String(req.body?.reason || "").trim().length < 8) {
    return next(new ErrorHandler("Opening closed books again needs a reason (at least 8 characters)", 400));
  }
  const settings = await AccountsSettings.findOneAndUpdate(
    { key: "accounts" },
    { $set: { lockDate, lockedBy: req.user?.name || "", lockedAt: new Date() } },
    { new: true }
  ).lean();
  res.json({ success: true, settings });
}));

// Bank reconciliation and the Tally export.
router.use(require("./accountsBank"));
router.use(require("./accountsTally"));
router.use(require("./accountsHealth"));
router.use(require("./accountsDocs"));
router.use(require("./accountsInsights"));
router.use(require("./accountsStatutory"));
router.use(require("./accountsRegisters"));

module.exports = router;
module.exports.postOpening = postOpening;
