"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS  —  /api/v2/accounts
//
//  The money side of the paperwork the rest of the app raises. Tally
//  stays the book of record; this is where the office enters supplier
//  bills and expenses, issues credit and debit notes, records what
//  came in and went out, and reads who owes what.
//
//    Masters      bank-accounts, categories
//    Bills        /bills, /bills/po-info, /bills/:id, /bills/:id/cancel
//    Expenses     /expenses, /expenses/:id/{approve,reject,pay,cancel}
//    Notes        /notes (credit to a customer, debit to a supplier)
//    Vouchers     /payments (receipts and payments, with allocations and TDS)
//    Ledgers      /statement, /outstanding, /overview
//    Reports      /reports/{gst,tds,expenses,cashbook,daybook}
//
//  Every document is numbered off its own series, carries a fingerprint
//  trail, and is cancelled (with a reason) rather than edited. Vouchers
//  and notes move the amounts on the documents they settle inside one
//  transaction, and post to the party ledger in the same one.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const mongoose = require("mongoose");
const multer   = require("multer");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAdmin }      = require("../middleware/auth");
const { keepRequestContext } = require("../middleware/userContext");
const { escapeRegex }  = require("../utils/escapeRegex");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { computeInvoice, stateCodeFromGstin, round2 } = require("../services/gst");
const { getDocumentSettings } = require("../services/documentSettings");
const { allocate } = require("../services/docNumbers");
const partyLedger  = require("../services/partyLedger");
const outstanding  = require("../services/outstanding");
const { ensureSeed } = require("../services/accountsSeed");
const { readBill }  = require("../utils/billOcr");
const bankStatement = require("../services/bankStatement");
const collections   = require("../services/collections");
const { sendWhatsApp, isConfigured: whatsappConfigured } = require("../utils/whatsapp");
const aiLedger      = require("../services/aiLedger");
const { promptVersion } = require("../utils/aiPrompts");

const BankAccount     = require("../models/BankAccount");
const ExpenseCategory = require("../models/ExpenseCategory");
const SupplierBill    = require("../models/SupplierBill");
const Expense         = require("../models/Expense");
const AccountNote     = require("../models/AccountNote");
const Payment         = require("../models/Payment");
const Invoice         = require("../models/Invoice");
const Supplier        = require("../models/Supplier");
const Customer        = require("../models/Customer");
const PurchaseOrder   = require("../models/PurchaseOrder");
const MaterialInward  = require("../models/MaterialInward");
const RawMaterial     = require("../models/RawMaterial");
const { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } = require("../models/accountsShared");

const MIN_REASON = 8;
const DAY = 86_400_000;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const r2 = round2;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4 } });

// ── Helpers ───────────────────────────────────────────────────────
function readDate(value, label, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ErrorHandler(`${label} is not a date`, 400);
  return d;
}

/** The seller's state, off Settings. */
async function sellerStateCode() {
  const s = await getDocumentSettings();
  return s.invoice?.stateCode || stateCodeFromGstin(s.gstin);
}

/** Lines from the client, checked and priced. */
function readLines(raw, { defaultGst = 5 } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw new ErrorHandler("At least one line is required", 400);
  return raw.map((l, i) => {
    const description = String(l?.description || "").trim();
    if (!description) throw new ErrorHandler(`Line ${i + 1}: description is required`, 400);
    const quantity = l?.quantity === undefined || l?.quantity === "" ? 1 : Number(l.quantity);
    const rate = Number(l?.rate);
    const gstPercent = l?.gstPercent === undefined || l?.gstPercent === null || l?.gstPercent === "" ? defaultGst : Number(l.gstPercent);
    if (!Number.isFinite(quantity) || quantity < 0) throw new ErrorHandler(`Line ${i + 1}: quantity must be 0 or more`, 400);
    if (!Number.isFinite(rate) || rate < 0) throw new ErrorHandler(`Line ${i + 1}: rate must be 0 or more`, 400);
    if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) throw new ErrorHandler(`Line ${i + 1}: GST % must be between 0 and 100`, 400);
    const hsn = String(l?.hsn || "").trim();
    if (hsn && !/^\d{4,8}$/.test(hsn)) throw new ErrorHandler(`Line ${i + 1}: HSN is 4 to 8 digits`, 400);
    return {
      rawMaterial: isId(l?.rawMaterial) ? l.rawMaterial : undefined,
      description: description.slice(0, 200), hsn, unit: String(l?.unit || "").trim().slice(0, 10),
      quantity, rate, gstPercent,
    };
  });
}

function priced(lines, sellerState, partyState) {
  const p = computeInvoice(lines, { sellerStateCode: sellerState, buyerStateCode: partyState });
  return {
    supplyType: p.supplyType,
    lines: p.lines.map((l) => ({
      rawMaterial: l.rawMaterial, description: l.description, hsn: l.hsn, unit: l.unit, quantity: l.quantity, rate: l.rate,
      taxable: l.taxable, gstPercent: l.gstPercent, cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount,
    })),
    totals: p.totals,
  };
}

const reasonFrom = (req) => {
  const reason = String(req.body?.reason || req.body?.auditReason || "").trim();
  if (reason.length < MIN_REASON) throw new ErrorHandler(`Give a reason (at least ${MIN_REASON} characters)`, 400);
  return reason;
};

const fp = (code, doc, req, meta) => buildFingerprint(code, { entityId: doc._id, actor: actorFromRequest(req), meta });

// withTransaction RETRIES the callback on a transient error, so every
// callback here is written to run twice safely: documents are created
// inside it from plain data (never .save() on a doc built outside), and
// existing documents are changed by updateOne or loaded inside it.
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    session.endSession();
  }
}

const dataUrl = (file) => `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;

/** A list query's paging and date range. */
function paging(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const range = {};
  const from = readDate(req.query.from, "from");
  const to = readDate(req.query.to, "to");
  if (from) range.$gte = from;
  if (to) range.$lte = new Date(to.getTime() + DAY - 1);
  return { page, limit, skip: (page - 1) * limit, range: from || to ? range : null };
}

// ══════════════════════════════════════════════════════════════════
//  MASTERS
// ══════════════════════════════════════════════════════════════════
router.get("/bank-accounts", catchAsyncErrors(async (_req, res) => {
  await ensureSeed();
  const accounts = await BankAccount.find({}).sort({ isDefault: -1, name: 1 }).lean();
  // The book balance per account: opening + receipts − payments.
  const sums = await Payment.aggregate([
    { $match: { status: "posted" } },
    { $group: { _id: "$account", receipts: { $sum: { $cond: [{ $eq: ["$kind", "receipt"] }, "$amount", 0] } }, payments: { $sum: { $cond: [{ $eq: ["$kind", "payment"] }, "$amount", 0] } } } },
  ]);
  const by = new Map(sums.map((s) => [String(s._id), s]));
  res.json({
    success: true,
    accounts: accounts.map((a) => {
      const s = by.get(String(a._id)) || { receipts: 0, payments: 0 };
      return { ...a, balance: r2((a.openingBalance || 0) + s.receipts - s.payments), receipts: r2(s.receipts), payments: r2(s.payments) };
    }),
  });
}));

const ACCOUNT_FIELDS = ["name", "kind", "bankName", "accountNo", "ifsc", "upiId", "openingBalance", "openingDate", "float", "active", "isDefault"];
function pickAccount(body) {
  const out = {};
  for (const f of ACCOUNT_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  if (out.openingDate !== undefined) out.openingDate = readDate(out.openingDate, "openingDate");
  if (out.openingBalance !== undefined && !Number.isFinite(Number(out.openingBalance))) throw new ErrorHandler("openingBalance must be a number", 400);
  return out;
}

router.post("/bank-accounts", isAdmin("admin"), catchAsyncErrors(async (req, res, next) => {
  const body = pickAccount(req.body || {});
  if (!String(body.name || "").trim()) return next(new ErrorHandler("name is required", 400));
  if (body.isDefault) await BankAccount.updateMany({}, { $set: { isDefault: false } });
  const account = await BankAccount.create(body);
  res.status(201).json({ success: true, account });
}));

router.put("/bank-accounts/:id", isAdmin("admin"), catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Account not found", 404));
  const body = pickAccount(req.body || {});
  if (body.isDefault) await BankAccount.updateMany({ _id: { $ne: req.params.id } }, { $set: { isDefault: false } });
  const account = await BankAccount.findByIdAndUpdate(req.params.id, { $set: body }, { new: true, runValidators: true });
  if (!account) return next(new ErrorHandler("Account not found", 404));
  res.json({ success: true, account });
}));

router.get("/categories", catchAsyncErrors(async (_req, res) => {
  await ensureSeed();
  res.json({ success: true, categories: await ExpenseCategory.find({}).sort({ name: 1 }).lean() });
}));

const CATEGORY_FIELDS = ["name", "ledger", "itcEligible", "approvalAbove", "tdsSection", "active"];
router.post("/categories", isAdmin("admin"), catchAsyncErrors(async (req, res, next) => {
  const body = {};
  for (const f of CATEGORY_FIELDS) if (req.body?.[f] !== undefined) body[f] = req.body[f];
  if (!String(body.name || "").trim()) return next(new ErrorHandler("name is required", 400));
  try {
    res.status(201).json({ success: true, category: await ExpenseCategory.create(body) });
  } catch (err) {
    if (err?.code === 11000) return next(new ErrorHandler("A category with that name exists", 409));
    throw err;
  }
}));

router.put("/categories/:id", isAdmin("admin"), catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Category not found", 404));
  const body = {};
  for (const f of CATEGORY_FIELDS) if (req.body?.[f] !== undefined) body[f] = req.body[f];
  const category = await ExpenseCategory.findByIdAndUpdate(req.params.id, { $set: body }, { new: true, runValidators: true });
  if (!category) return next(new ErrorHandler("Category not found", 404));
  res.json({ success: true, category });
}));

// ══════════════════════════════════════════════════════════════════
//  SUPPLIER BILLS
// ══════════════════════════════════════════════════════════════════

/** What a bill against this PO would hold: the receipts not yet billed. */
router.get("/bills/po-info", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.query.id)) return next(new ErrorHandler("Purchase order not found", 404));
  const po = await PurchaseOrder.findById(req.query.id).populate("supplier", "name gstin address").populate("items.rawMaterial", "name unit hsn").lean();
  if (!po) return next(new ErrorHandler("Purchase order not found", 404));
  const inwards = await MaterialInward.find({ purchaseOrder: po._id }).populate("rawMaterial", "name unit").sort({ inwardDate: 1 }).lean();
  const billed = await SupplierBill.find({ purchaseOrder: po._id, status: { $ne: "cancelled" } }).select("billNo inwards supplierBillNo totals").lean();
  const onBill = new Map();
  for (const b of billed) for (const i of b.inwards || []) onBill.set(String(i), b.billNo);
  const settings = await getDocumentSettings();
  const defaultGst = settings.invoice?.defaultGstPercent ?? 5;
  const price = new Map((po.items || []).map((it) => [String(it.rawMaterial?._id || it.rawMaterial), Number(it.price) || 0]));
  const free = inwards.filter((i) => !onBill.has(String(i._id)));
  // One line per material across the unbilled receipts, at the PO price.
  const lines = new Map();
  for (const i of free) {
    const key = String(i.rawMaterial?._id || i.rawMaterial);
    const row = lines.get(key) || { rawMaterial: key, description: i.rawMaterial?.name || "Material", unit: i.rawMaterial?.unit || "kg", quantity: 0, rate: price.get(key) || i.unitPrice || 0, gstPercent: defaultGst, hsn: "", inwards: [] };
    row.quantity = Math.round((row.quantity + (i.quantity || 0)) * 1000) / 1000;
    row.inwards.push(String(i._id));
    lines.set(key, row);
  }
  res.json({
    success: true,
    po: { _id: po._id, poNo: po.poNo, date: po.date, status: po.status, supplier: po.supplier },
    inwards: inwards.map((i) => ({ _id: i._id, date: i.inwardDate, material: i.rawMaterial?.name || "", quantity: i.quantity, unit: i.rawMaterial?.unit || "", lotNo: i.lotNo, unitPrice: i.unitPrice, billedOn: onBill.get(String(i._id)) || null })),
    bills: billed.map((b) => ({ _id: b._id, billNo: b.billNo, supplierBillNo: b.supplierBillNo, grand: b.totals?.grand || 0 })),
    lines: [...lines.values()],
  });
}));

router.get("/bills", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (range) q.billDate = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ billNo: re }, { supplierBillNo: re }, { supplierName: re }];
    if (/^\d+$/.test(search)) q.$or.push({ poNo: Number(search) });
  }
  const [total, bills] = await Promise.all([
    SupplierBill.countDocuments(q),
    SupplierBill.find(q).select("-attachments.data -lines").sort({ billDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({
    success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)),
    bills: bills.map((b) => ({ ...b, outstanding: r2((b.totals?.grand || 0) - b.paidAmount - b.tdsAmount - b.debitedAmount) })),
  });
}));

router.get("/bills/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Bill not found", 404));
  const bill = await SupplierBill.findById(req.params.id).select("-attachments.data").populate("category", "name").lean();
  if (!bill) return next(new ErrorHandler("Bill not found", 404));
  const [payments, notes] = await Promise.all([
    Payment.find({ "allocations.doc": bill._id, status: "posted" }).select("voucherNo date amount mode reference allocations tds").lean(),
    AccountNote.find({ "against.doc": bill._id, status: "issued" }).select("noteNo date totals reason").lean(),
  ]);
  res.json({
    success: true,
    bill: { ...bill, outstanding: r2((bill.totals?.grand || 0) - bill.paidAmount - bill.tdsAmount - bill.debitedAmount) },
    payments: payments.map((p) => ({ _id: p._id, voucherNo: p.voucherNo, date: p.date, mode: p.mode, reference: p.reference, ...(p.allocations.find((a) => String(a.doc) === String(bill._id)) || {}) })),
    notes,
  });
}));

router.post("/bills", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (!isId(b.supplier)) return next(new ErrorHandler("supplier is required", 400));
  const supplierBillNo = String(b.supplierBillNo || "").trim();
  if (!supplierBillNo) return next(new ErrorHandler("The supplier's bill number is required", 400));
  if (b.requestId) {
    const dup = await SupplierBill.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return res.status(200).json({ success: true, bill: dup, replay: true });
  }
  const supplier = await Supplier.findById(b.supplier).lean();
  if (!supplier) return next(new ErrorHandler("Supplier not found", 404));
  let billDate, dueDate, lines;
  try {
    billDate = readDate(b.billDate, "billDate", new Date());
    dueDate = readDate(b.dueDate, "dueDate", new Date(billDate.getTime() + 30 * DAY));
    lines = readLines(b.lines, { defaultGst: (await getDocumentSettings()).invoice?.defaultGstPercent ?? 5 });
  } catch (err) { return next(err); }
  let po = null;
  if (b.purchaseOrder) {
    if (!isId(b.purchaseOrder)) return next(new ErrorHandler("purchaseOrder is not an id", 400));
    po = await PurchaseOrder.findById(b.purchaseOrder).select("poNo supplier").lean();
    if (!po) return next(new ErrorHandler("Purchase order not found", 404));
    if (String(po.supplier) !== String(supplier._id)) return next(new ErrorHandler("That purchase order is on another supplier", 400));
  }
  const inwardIds = Array.isArray(b.inwards) ? b.inwards.filter(isId) : [];
  if (inwardIds.length) {
    const taken = await SupplierBill.findOne({ inwards: { $in: inwardIds }, status: { $ne: "cancelled" } }).select("billNo").lean();
    if (taken) return next(new ErrorHandler(`A receipt on this bill is already on ${taken.billNo}`, 409));
  }
  const supplierState = stateCodeFromGstin(supplier.gstin);
  const p = priced(lines, await sellerStateCode(), supplierState);
  const itcEligible = b.itcEligible !== false;
  const tdsRate = Number(b.tds?.rate) || 0;
  const tds = { applicable: !!b.tds?.applicable && tdsRate > 0, section: String(b.tds?.section || "").trim().slice(0, 8), rate: tdsRate };
  if (tds.applicable && (tdsRate < 0 || tdsRate > 100)) return next(new ErrorHandler("TDS rate must be between 0 and 100", 400));

  const { financialYear, sequence, number } = await allocate(SupplierBill, "PB", { at: billDate });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, billNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined,
    supplier: supplier._id, supplierName: supplier.name, supplierGstin: String(supplier.gstin || "").toUpperCase(), supplierStateCode: supplierState,
    supplierBillNo: supplierBillNo.slice(0, 40), billDate, dueDate,
    purchaseOrder: po?._id, poNo: po?.poNo, inwards: inwardIds,
    kind: b.kind === "service" ? "service" : "goods", category: isId(b.category) ? b.category : undefined,
    supplyType: p.supplyType, lines: p.lines, totals: p.totals,
    itc: { eligible: itcEligible, amount: itcEligible ? p.totals.tax : 0 },
    tds, notes: String(b.notes || "").trim().slice(0, 500), source: b.source === "scan" ? "scan" : "manual",
    aiSuggestion: isId(b.aiSuggestion) ? b.aiSuggestion : undefined, createdBy: req.user?._id,
    fingerprints: [fp(ACTION_CODES.BILL_CREATED, { _id }, req, { billNo: number, supplierBillNo, supplier: supplier.name, grand: p.totals.grand })],
  };
  let doc;
  try {
    await withTxn(async (session) => {
      [doc] = await SupplierBill.create([data], { session });
      await partyLedger.post({ partyType: "supplier", party: supplier._id, date: billDate, docType: "SupplierBill", doc: _id, docNo: number, credit: p.totals.grand, narration: `Bill ${supplierBillNo}${po ? ` · PO #${po.poNo}` : ""}` }, session);
    });
  } catch (err) {
    if (err?.code === 11000) {
      if (b.requestId) {
        const dup = await SupplierBill.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
        if (dup) return res.status(200).json({ success: true, bill: dup, replay: true });
      }
      return next(new ErrorHandler(`Bill ${supplierBillNo} from ${supplier.name} is already entered`, 409));
    }
    throw err;
  }
  res.status(201).json({ success: true, bill: doc.toObject() });
}));

router.post("/bills/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Bill not found", 404));
  const bill = await SupplierBill.findById(req.params.id);
  if (!bill) return next(new ErrorHandler("Bill not found", 404));
  if (bill.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  if (bill.paidAmount > 0 || bill.tdsAmount > 0 || bill.debitedAmount > 0) {
    return next(new ErrorHandler("Payments or debit notes are allocated to this bill — cancel those first.", 409));
  }
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  const cancel = { reason, at: new Date(), by: req.user?._id };
  const mark = fp(ACTION_CODES.BILL_CANCELLED, bill, req, { billNo: bill.billNo, reason });
  await withTxn(async (session) => {
    await SupplierBill.updateOne({ _id: bill._id }, { $set: { status: "cancelled", cancel }, $push: { fingerprints: mark } }, { session });
    await partyLedger.reverse("SupplierBill", bill._id, session);
  });
  res.json({ success: true, bill: await SupplierBill.findById(bill._id).select("-attachments.data").lean() });
}));

// ── Attachments (bills, expenses, notes, vouchers share one shape) ──
const ATTACHABLE = { bills: SupplierBill, expenses: Expense, notes: AccountNote, payments: Payment };

router.post("/:kind(bills|expenses|notes|payments)/:id/attachments", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  const Model = ATTACHABLE[req.params.kind];
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  if (!req.file) return next(new ErrorHandler("Attach a file (image or PDF)", 400));
  if (!ATTACHMENT_TYPES.includes(req.file.mimetype)) return next(new ErrorHandler("Only JPEG, PNG, WebP or PDF", 400));
  const doc = await Model.findById(req.params.id).select("attachments");
  if (!doc) return next(new ErrorHandler("Not found", 404));
  if (doc.attachments.length >= 5) return next(new ErrorHandler("At most 5 attachments", 400));
  doc.attachments.push({ filename: req.file.originalname || "", contentType: req.file.mimetype, size: req.file.size, data: dataUrl(req.file) });
  await doc.save();
  const a = doc.attachments[doc.attachments.length - 1];
  res.status(201).json({ success: true, attachment: { _id: a._id, filename: a.filename, contentType: a.contentType, size: a.size, uploadedAt: a.uploadedAt } });
}));

router.get("/:kind(bills|expenses|notes|payments)/:id/attachments/:aid", catchAsyncErrors(async (req, res, next) => {
  const Model = ATTACHABLE[req.params.kind];
  if (!isId(req.params.id) || !isId(req.params.aid)) return next(new ErrorHandler("Not found", 404));
  const doc = await Model.findById(req.params.id).select("attachments").lean();
  const a = doc?.attachments?.find((x) => String(x._id) === String(req.params.aid));
  if (!a) return next(new ErrorHandler("Not found", 404));
  const base64 = String(a.data).split(",")[1] || "";
  res.setHeader("Content-Type", a.contentType);
  res.setHeader("Content-Disposition", `inline; filename="${(a.filename || "attachment").replace(/"/g, "")}"`);
  res.send(Buffer.from(base64, "base64"));
}));

// ══════════════════════════════════════════════════════════════════
//  EXPENSES
// ══════════════════════════════════════════════════════════════════
router.get("/expenses", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.category)) q.category = req.query.category;
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (range) q.date = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ expenseNo: re }, { description: re }, { payeeName: re }, { refNo: re }, { categoryName: re }];
  }
  const [total, expenses, pendingCount] = await Promise.all([
    Expense.countDocuments(q),
    Expense.find(q).select("-attachments.data -lines").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Expense.countDocuments({ status: "pending" }),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), pendingCount, expenses });
}));

router.get("/expenses/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Expense not found", 404));
  const expense = await Expense.findById(req.params.id).select("-attachments.data").populate("paidFrom", "name kind").lean();
  if (!expense) return next(new ErrorHandler("Expense not found", 404));
  const payments = await Payment.find({ "allocations.doc": expense._id, status: "posted" }).select("voucherNo date amount mode reference accountName").lean();
  res.json({ success: true, expense, payments });
}));

/** The voucher that pays an expense, inside the caller's transaction. */
//
// The voucher number is drawn BEFORE the transaction (payVoucherNo) —
// withTransaction retries a transient conflict by running the callback
// again, and a number drawn inside it would be burnt on every retry.
async function payVoucherNo(when) { return allocate(Payment, "PAY", { extra: { kind: "payment" }, at: when || new Date() }); }

async function payExpense(expenseId, { account, mode, reference, date, req, voucherNo }, session) {
  const expense = await Expense.findById(expenseId).session(session);
  if (!expense) throw new ErrorHandler("Expense not found", 404);
  const acct = await BankAccount.findById(account).session(session);
  if (!acct || !acct.active) throw new ErrorHandler("Pick the account the money went from", 400);
  const amount = expense.outstanding();
  if (amount <= 0) throw new ErrorHandler("Nothing left to pay on this expense", 409);
  const when = date || new Date();
  const { financialYear, sequence, number } = voucherNo;
  const partyType = expense.supplier ? "supplier" : "other";
  const vId = new mongoose.Types.ObjectId();
  const voucherData = {
    _id: vId, kind: "payment", voucherNo: number, financialYear, sequence, date: when,
    partyType, supplier: expense.supplier || undefined, partyName: expense.payeeName || expense.categoryName || "Expense",
    amount, mode: mode || (acct.kind === "cash" ? "cash" : acct.kind === "upi" ? "upi" : "bank"), account: acct._id, accountName: acct.name,
    reference: String(reference || "").trim().slice(0, 60),
    allocations: [{ docType: "Expense", doc: expense._id, docNo: expense.expenseNo, amount, tds: 0 }],
    unallocated: 0, narration: `${expense.categoryName}: ${expense.description}`, createdBy: req.user?._id,
    fingerprints: [fp(ACTION_CODES.PAYMENT_POSTED, { _id: vId }, req, { voucherNo: number, amount, expense: expense.expenseNo })],
  };
  const [voucher] = await Payment.create([voucherData], { session });
  await Expense.updateOne({ _id: expense._id }, {
    $set: { paidAmount: r2(expense.paidAmount + amount), paidFrom: acct._id, paidAt: when, status: "paid" },
    $push: { fingerprints: fp(ACTION_CODES.EXPENSE_PAID, expense, req, { voucherNo: number, amount, account: acct.name }) },
  }, { session });
  if (expense.supplier) {
    await partyLedger.post({ partyType: "supplier", party: expense.supplier, date: when, docType: "Payment", doc: vId, docNo: number, debit: amount, narration: voucherData.narration }, session);
  }
  return voucher;
}

router.post("/expenses", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (b.requestId) {
    const dup = await Expense.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return res.status(200).json({ success: true, expense: dup, replay: true });
  }
  if (!isId(b.category)) return next(new ErrorHandler("category is required", 400));
  const category = await ExpenseCategory.findById(b.category).lean();
  if (!category) return next(new ErrorHandler("Category not found", 404));
  const description = String(b.description || "").trim();
  if (!description) return next(new ErrorHandler("description is required", 400));
  let date, lines;
  try {
    date = readDate(b.date, "date", new Date());
    // A plain amount is one line; itemised bills send lines.
    const raw = Array.isArray(b.lines) && b.lines.length ? b.lines : [{ description, quantity: 1, rate: b.amount, gstPercent: b.gstPercent ?? 0 }];
    lines = readLines(raw, { defaultGst: 0 });
  } catch (err) { return next(err); }
  let supplier = null;
  if (b.supplier) {
    if (!isId(b.supplier)) return next(new ErrorHandler("supplier is not an id", 400));
    supplier = await Supplier.findById(b.supplier).lean();
    if (!supplier) return next(new ErrorHandler("Supplier not found", 404));
  }
  const payeeGstin = String(b.payeeGstin || supplier?.gstin || "").trim().toUpperCase();
  const p = priced(lines, await sellerStateCode(), stateCodeFromGstin(payeeGstin));
  const itcEligible = b.itcEligible === undefined ? !!category.itcEligible && p.totals.tax > 0 : !!b.itcEligible;
  const needsApproval = category.approvalAbove === 0 || p.totals.grand > category.approvalAbove;

  const { financialYear, sequence, number } = await allocate(Expense, "EXP", { at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, expenseNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined,
    date, category: category._id, categoryName: category.name, description: description.slice(0, 200),
    supplier: supplier?._id, payeeName: String(b.payeeName || supplier?.name || "").trim().slice(0, 120), payeeGstin,
    refNo: String(b.refNo || "").trim().slice(0, 40),
    supplyType: p.supplyType, lines: p.lines, totals: p.totals,
    itc: { eligible: itcEligible, amount: itcEligible ? p.totals.tax : 0 },
    status: needsApproval ? "pending" : "approved",
    approval: { required: needsApproval },
    submittedBy: req.user?._id, submittedByName: req.user?.name || "",
    notes: String(b.notes || "").trim().slice(0, 500), source: b.source === "scan" ? "scan" : "manual",
    aiSuggestion: isId(b.aiSuggestion) ? b.aiSuggestion : undefined,
    fingerprints: [fp(ACTION_CODES.EXPENSE_SUBMITTED, { _id }, req, { expenseNo: number, category: category.name, grand: p.totals.grand, needsApproval })],
  };
  let voucher = null;
  const payNow = b.payNow && !needsApproval ? b.payNow : null;
  if (payNow && !isId(payNow.account)) return next(new ErrorHandler("payNow.account is required", 400));
  const payNo = payNow ? await payVoucherNo(date) : null;
  try {
    await withTxn(async (session) => {
      await Expense.create([data], { session });
      if (!needsApproval && supplier) {
        await partyLedger.post({ partyType: "supplier", party: supplier._id, date, docType: "Expense", doc: _id, docNo: number, credit: p.totals.grand, narration: `${category.name}: ${description}` }, session);
      }
      // Paid on the spot (petty cash, UPI from the phone): the voucher
      // comes with it — but only once it needs no approval.
      if (payNow) {
        voucher = await payExpense(_id, { account: payNow.account, mode: payNow.mode, reference: payNow.reference, date, req, voucherNo: payNo }, session);
      }
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    if (err?.code === 11000 && b.requestId) {
      const dup = await Expense.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
      if (dup) return res.status(200).json({ success: true, expense: dup, replay: true });
    }
    throw err;
  }
  const expense = await Expense.findById(_id).select("-attachments.data").lean();
  res.status(201).json({ success: true, expense, voucher: voucher ? { _id: voucher._id, voucherNo: voucher.voucherNo } : null });
}));

async function loadExpense(req, next) {
  if (!isId(req.params.id)) { next(new ErrorHandler("Expense not found", 404)); return null; }
  const e = await Expense.findById(req.params.id);
  if (!e) { next(new ErrorHandler("Expense not found", 404)); return null; }
  return e;
}

router.post("/expenses/:id/approve", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status !== "pending") return next(new ErrorHandler(`This expense is ${e.status}, not waiting for approval`, 409));
  if (String(e.submittedBy || "") === String(req.user?._id || "") && req.user?.role !== "admin") {
    return next(new ErrorHandler("An expense is approved by someone other than the person who entered it", 403));
  }
  const approval = { required: true, by: req.user?._id, byName: req.user?.name || "", at: new Date(), note: String(req.body?.note || "").trim().slice(0, 200) };
  const mark = fp(ACTION_CODES.EXPENSE_APPROVED, e, req, { expenseNo: e.expenseNo, grand: e.totals.grand });
  let voucher = null;
  const payNow = req.body?.payNow?.account ? req.body.payNow : null;
  if (payNow && !isId(payNow.account)) return next(new ErrorHandler("payNow.account is required", 400));
  const payNo = payNow ? await payVoucherNo(new Date()) : null;
  try {
    await withTxn(async (session) => {
      await Expense.updateOne({ _id: e._id }, { $set: { status: "approved", approval }, $push: { fingerprints: mark } }, { session });
      if (e.supplier) {
        await partyLedger.post({ partyType: "supplier", party: e.supplier, date: e.date, docType: "Expense", doc: e._id, docNo: e.expenseNo, credit: e.totals.grand, narration: `${e.categoryName}: ${e.description}` }, session);
      }
      if (payNow) {
        voucher = await payExpense(e._id, { account: payNow.account, mode: payNow.mode, reference: payNow.reference, date: new Date(), req, voucherNo: payNo }, session);
      }
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean(), voucher: voucher ? { _id: voucher._id, voucherNo: voucher.voucherNo } : null });
}));

router.post("/expenses/:id/reject", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status !== "pending") return next(new ErrorHandler(`This expense is ${e.status}, not waiting for approval`, 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  e.status = "rejected";
  e.approval = { required: true, by: req.user?._id, byName: req.user?.name || "", at: new Date(), note: reason };
  e.fingerprints.push(fp(ACTION_CODES.EXPENSE_REJECTED, e, req, { expenseNo: e.expenseNo, reason }));
  await e.save();
  res.json({ success: true, expense: e.toObject() });
}));

router.post("/expenses/:id/pay", catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status !== "approved") return next(new ErrorHandler(`Only an approved expense can be paid (this one is ${e.status})`, 409));
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  let date;
  try { date = readDate(req.body?.date, "date", new Date()); } catch (err) { return next(err); }
  let voucher;
  const payNo = await payVoucherNo(date);
  try {
    await withTxn(async (session) => {
      voucher = await payExpense(e._id, { account: req.body.account, mode: req.body.mode, reference: req.body.reference, date, req, voucherNo: payNo }, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean(), voucher: { _id: voucher._id, voucherNo: voucher.voucherNo } });
}));

router.post("/expenses/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  if (e.paidAmount > 0) return next(new ErrorHandler("This expense has been paid — cancel the payment voucher first.", 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  const mark = fp(ACTION_CODES.EXPENSE_CANCELLED, e, req, { expenseNo: e.expenseNo, reason });
  await withTxn(async (session) => {
    await Expense.updateOne({ _id: e._id }, { $set: { status: "cancelled" }, $push: { fingerprints: mark } }, { session });
    await partyLedger.reverse("Expense", e._id, session);
  });
  res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean() });
}));

// ══════════════════════════════════════════════════════════════════
//  CREDIT / DEBIT NOTES
// ══════════════════════════════════════════════════════════════════
router.get("/notes", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.kind === "credit" || req.query.kind === "debit") q.kind = req.query.kind;
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.customer)) q.customer = req.query.customer;
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (range) q.date = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ noteNo: re }, { partyName: re }, { "against.docNo": re }, { reason: re }];
  }
  const [total, notes] = await Promise.all([
    AccountNote.countDocuments(q),
    AccountNote.find(q).select("-attachments.data -lines").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), notes });
}));

router.get("/notes/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Note not found", 404));
  const note = await AccountNote.findById(req.params.id).select("-attachments.data").lean();
  if (!note) return next(new ErrorHandler("Note not found", 404));
  res.json({ success: true, note });
}));

router.post("/notes", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  const kind = b.kind === "debit" ? "debit" : b.kind === "credit" ? "credit" : null;
  if (!kind) return next(new ErrorHandler("kind must be credit or debit", 400));
  if (b.requestId) {
    const dup = await AccountNote.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return res.status(200).json({ success: true, note: dup, replay: true });
  }
  const reason = String(b.reason || "").trim();
  if (reason.length < 3) return next(new ErrorHandler("reason is required", 400));
  if (!isId(b.against?.doc)) return next(new ErrorHandler("against.doc is required", 400));
  // A credit note is against our invoice; a debit note against their bill.
  const docType = kind === "credit" ? "Invoice" : "SupplierBill";
  const target = docType === "Invoice"
    ? await Invoice.findById(b.against.doc)
    : await SupplierBill.findById(b.against.doc);
  if (!target) return next(new ErrorHandler(`${docType === "Invoice" ? "Invoice" : "Bill"} not found`, 404));
  if (docType === "Invoice" && target.status !== "issued") return next(new ErrorHandler("That invoice is cancelled", 409));
  if (docType === "SupplierBill" && target.status === "cancelled") return next(new ErrorHandler("That bill is cancelled", 409));
  let date, lines;
  try {
    date = readDate(b.date, "date", new Date());
    lines = readLines(b.lines, { defaultGst: target.lines?.[0]?.gstPercent ?? 5 });
  } catch (err) { return next(err); }
  const partyType = kind === "credit" ? "customer" : "supplier";
  const partyState = docType === "Invoice" ? target.buyer?.stateCode : target.supplierStateCode;
  const p = priced(lines, await sellerStateCode(), partyState);
  const party = docType === "Invoice" ? target.customer : target.supplier;
  const partyName = docType === "Invoice" ? target.buyer?.name : target.supplierName;
  const partyGstin = docType === "Invoice" ? target.buyer?.gstin : target.supplierGstin;

  const { financialYear, sequence, number } = await allocate(AccountNote, kind === "credit" ? "CN" : "DN", { extra: { kind }, at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, kind, noteNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
    partyType, customer: partyType === "customer" ? party : undefined, supplier: partyType === "supplier" ? party : undefined,
    partyName, partyGstin: partyGstin || "",
    against: { docType, doc: target._id, docNo: docType === "Invoice" ? target.invoiceNumber : target.billNo },
    reason: reason.slice(0, 200), supplyType: p.supplyType, lines: p.lines, totals: p.totals,
    notes: String(b.notes || "").trim().slice(0, 500), createdBy: req.user?._id,
  };
  data.fingerprints = [fp(ACTION_CODES.NOTE_ISSUED, { _id }, req, { noteNo: number, against: data.against.docNo, grand: p.totals.grand, reason })];
  let note;
  try {
    await withTxn(async (session) => {
      [note] = await AccountNote.create([data], { session });
      if (docType === "Invoice") {
        await Invoice.updateOne({ _id: target._id }, { $inc: { creditedAmount: p.totals.grand } }, { session });
      } else {
        const bill = await SupplierBill.findById(target._id).session(session);
        const next_ = r2(bill.debitedAmount + p.totals.grand);
        const left = r2(bill.totals.grand - bill.paidAmount - bill.tdsAmount - next_);
        await SupplierBill.updateOne({ _id: bill._id }, { $set: { debitedAmount: next_, status: left <= 0.005 ? "paid" : (bill.paidAmount + bill.tdsAmount > 0 ? "part_paid" : "open") } }, { session });
      }
      await partyLedger.post({
        partyType, party, date, docType: "AccountNote", doc: _id, docNo: number,
        ...(kind === "credit" ? { credit: p.totals.grand } : { debit: p.totals.grand }), narration: `${reason} (${note.against.docNo})`,
      }, session);
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await AccountNote.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
      if (dup) return res.status(200).json({ success: true, note: dup, replay: true });
    }
    throw err;
  }
  res.status(201).json({ success: true, note: note.toObject() });
}));

router.post("/notes/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Note not found", 404));
  const note = await AccountNote.findById(req.params.id);
  if (!note) return next(new ErrorHandler("Note not found", 404));
  if (note.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  const cancel = { reason, at: new Date(), by: req.user?._id };
  const mark = fp(ACTION_CODES.NOTE_CANCELLED, note, req, { noteNo: note.noteNo, reason });
  await withTxn(async (session) => {
    await AccountNote.updateOne({ _id: note._id }, { $set: { status: "cancelled", cancel }, $push: { fingerprints: mark } }, { session });
    const amt = note.totals.grand;
    if (note.against.docType === "Invoice") {
      await Invoice.updateOne({ _id: note.against.doc }, { $inc: { creditedAmount: -amt } }, { session });
    } else {
      const bill = await SupplierBill.findById(note.against.doc).session(session);
      if (bill) {
        const debited = r2(bill.debitedAmount - amt);
        const left = r2(bill.totals.grand - bill.paidAmount - bill.tdsAmount - debited);
        const status = bill.status === "cancelled" ? "cancelled" : left <= 0.005 ? "paid" : (bill.paidAmount + bill.tdsAmount > 0 ? "part_paid" : "open");
        await SupplierBill.updateOne({ _id: bill._id }, { $set: { debitedAmount: debited, status } }, { session });
      }
    }
    await partyLedger.reverse("AccountNote", note._id, session);
  });
  res.json({ success: true, note: await AccountNote.findById(note._id).select("-attachments.data").lean() });
}));

// ══════════════════════════════════════════════════════════════════
//  RECEIPTS AND PAYMENTS
// ══════════════════════════════════════════════════════════════════

/** The open documents a voucher for this party could settle. */
router.get("/payments/open-docs", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  if (partyType === "customer") {
    const rows = await outstanding.receivables({ customer: req.query.party });
    const balance = (await partyLedger.balances("customer", [req.query.party])).get(String(req.query.party)) || 0;
    return res.json({ success: true, docs: rows, balance });
  }
  if (partyType === "supplier") {
    const rows = await outstanding.payables({ supplier: req.query.party });
    const balance = (await partyLedger.balances("supplier", [req.query.party])).get(String(req.query.party)) || 0;
    return res.json({ success: true, docs: rows, balance });
  }
  return next(new ErrorHandler("partyType must be customer or supplier", 400));
}));

router.get("/payments", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.kind === "receipt" || req.query.kind === "payment") q.kind = req.query.kind;
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.customer)) q.customer = req.query.customer;
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (isId(req.query.account)) q.account = req.query.account;
  if (range) q.date = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ voucherNo: re }, { partyName: re }, { reference: re }, { narration: re }, { "allocations.docNo": re }];
  }
  const [total, payments] = await Promise.all([
    Payment.countDocuments(q),
    Payment.find(q).select("-attachments.data").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), payments });
}));

router.get("/payments/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Voucher not found", 404));
  const payment = await Payment.findById(req.params.id).select("-attachments.data").lean();
  if (!payment) return next(new ErrorHandler("Voucher not found", 404));
  res.json({ success: true, payment });
}));

const DOC_MODELS = { Invoice, SupplierBill, Expense };
const docNoOf = (docType, d) => (docType === "Invoice" ? d.invoiceNumber : docType === "SupplierBill" ? d.billNo : d.expenseNo);
const docOutstanding = (docType, d) =>
  docType === "Invoice" ? r2(d.totals.grand - (d.paidAmount || 0) - (d.creditedAmount || 0))
  : docType === "SupplierBill" ? r2(d.totals.grand - d.paidAmount - d.tdsAmount - d.debitedAmount)
  : r2(d.totals.grand - d.paidAmount);

/**
 * Post a receipt or payment voucher from a request body. Throws an
 * ErrorHandler for anything the caller got wrong; returns the voucher
 * (or the one a replayed requestId already made).
 */
async function createVoucher(b, req) {
  const kind = b.kind === "receipt" ? "receipt" : b.kind === "payment" ? "payment" : null;
  if (!kind) throw new ErrorHandler("kind must be receipt or payment", 400);
  if (b.requestId) {
    const dup = await Payment.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return { voucher: dup, replay: true };
  }
  const amount = r2(b.amount);
  if (!(amount > 0)) throw new ErrorHandler("amount must be more than 0", 400);
  if (!["cash", "bank", "upi", "cheque"].includes(b.mode)) throw new ErrorHandler("mode must be cash, bank, upi or cheque", 400);
  if (!isId(b.account)) throw new ErrorHandler("account is required", 400);
  const account = await BankAccount.findById(b.account).lean();
  if (!account || !account.active) throw new ErrorHandler("Account not found", 404);
  let date;
  date = readDate(b.date, "date", new Date());

  // The party.
  const partyType = b.partyType;
  let party = null;
  let partyName = String(b.partyName || "").trim();
  if (partyType === "customer") {
    if (kind !== "receipt") throw new ErrorHandler("A customer is paid by a receipt voucher", 400);
    if (!isId(b.customer)) throw new ErrorHandler("customer is required", 400);
    party = await Customer.findById(b.customer).select("name").lean();
    if (!party) throw new ErrorHandler("Customer not found", 404);
    partyName = party.name;
  } else if (partyType === "supplier") {
    if (kind !== "payment") throw new ErrorHandler("A supplier is paid by a payment voucher", 400);
    if (!isId(b.supplier)) throw new ErrorHandler("supplier is required", 400);
    party = await Supplier.findById(b.supplier).select("name").lean();
    if (!party) throw new ErrorHandler("Supplier not found", 404);
    partyName = party.name;
  } else if (partyType === "other") {
    if (!partyName) throw new ErrorHandler("partyName is required for an other-party voucher", 400);
  } else {
    throw new ErrorHandler("partyType must be customer, supplier or other", 400);
  }

  // TDS, on payments only.
  const tdsRate = kind === "payment" ? Number(b.tds?.rate) || 0 : 0;
  if (tdsRate < 0 || tdsRate > 100) throw new ErrorHandler("TDS rate must be between 0 and 100", 400);
  const tdsSection = String(b.tds?.section || "").trim().slice(0, 8);

  // The allocations: each names an open document of this party, for a
  // GROSS amount (what the document is settled by); TDS comes off it.
  const rawAlloc = Array.isArray(b.allocations) ? b.allocations : [];
  const allowedTypes = partyType === "customer" ? ["Invoice"] : partyType === "supplier" ? ["SupplierBill", "Expense"] : ["Expense"];
  const allocations = [];
  const seen = new Set();
  for (const [i, a] of rawAlloc.entries()) {
    if (!allowedTypes.includes(a?.docType)) throw new ErrorHandler(`Allocation ${i + 1}: a ${kind} to this party cannot settle a ${a?.docType || "?"}`, 400);
    if (!isId(a.doc)) throw new ErrorHandler(`Allocation ${i + 1}: doc is required`, 400);
    if (seen.has(String(a.doc))) throw new ErrorHandler(`Allocation ${i + 1}: the same document twice`, 400);
    seen.add(String(a.doc));
    const gross = r2(a.amount);
    if (!(gross > 0)) throw new ErrorHandler(`Allocation ${i + 1}: amount must be more than 0`, 400);
    const doc = await DOC_MODELS[a.docType].findById(a.doc);
    if (!doc) throw new ErrorHandler(`Allocation ${i + 1}: document not found`, 404);
    const docParty = a.docType === "Invoice" ? doc.customer : doc.supplier;
    if (party && String(docParty) !== String(party._id)) throw new ErrorHandler(`Allocation ${i + 1}: ${docNoOf(a.docType, doc)} belongs to another party`, 400);
    const open = (a.docType === "Invoice" && doc.status === "issued") || (a.docType === "SupplierBill" && ["open", "part_paid"].includes(doc.status)) || (a.docType === "Expense" && doc.status === "approved");
    if (!open) throw new ErrorHandler(`Allocation ${i + 1}: ${docNoOf(a.docType, doc)} is not open`, 409);
    const left = docOutstanding(a.docType, doc);
    if (gross > left + 0.005) throw new ErrorHandler(`Allocation ${i + 1}: ${docNoOf(a.docType, doc)} has only ${left.toFixed(2)} outstanding`, 400);
    const tds = a.docType === "SupplierBill" && (doc.tds?.applicable || tdsRate > 0) ? r2(gross * (tdsRate || doc.tds?.rate || 0) / 100) : (tdsRate > 0 && a.docType === "Expense" ? r2(gross * tdsRate / 100) : 0);
    allocations.push({ docType: a.docType, doc: doc._id, docNo: docNoOf(a.docType, doc), amount: gross, tds });
  }
  const tdsAmount = r2(allocations.reduce((s, a) => s + a.tds, 0));
  const gross = r2(allocations.reduce((s, a) => s + a.amount, 0));
  const cashNeeded = r2(gross - tdsAmount);
  if (cashNeeded > amount + 0.005) {
    throw new ErrorHandler(`The allocations need ${cashNeeded.toFixed(2)} but the voucher is for ${amount.toFixed(2)}`, 400);
  }
  const unallocated = r2(amount + tdsAmount - gross);

  const { financialYear, sequence, number } = await allocate(Payment, kind === "receipt" ? "RCT" : "PAY", { extra: { kind }, at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, kind, voucherNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
    partyType, customer: partyType === "customer" ? party._id : undefined, supplier: partyType === "supplier" ? party._id : undefined, partyName,
    amount, mode: b.mode, account: account._id, accountName: account.name, reference: String(b.reference || "").trim().slice(0, 60),
    tds: { section: tdsAmount > 0 ? tdsSection : "", rate: tdsAmount > 0 ? tdsRate : 0, amount: tdsAmount },
    allocations, unallocated, narration: String(b.narration || "").trim().slice(0, 300),
    source: b.source === "statement" ? "statement" : "manual", statementLine: String(b.statementLine || "").slice(0, 200),
    createdBy: req.user?._id,
  };
  data.fingerprints = [fp(ACTION_CODES.PAYMENT_POSTED, { _id }, req, { voucherNo: number, amount, tds: tdsAmount, docs: allocations.map((a) => a.docNo) })];

  let voucher;
  try {
    await withTxn(async (session) => {
      [voucher] = await Payment.create([data], { session });
      for (const a of allocations) {
        if (a.docType === "Invoice") {
          await Invoice.updateOne({ _id: a.doc }, { $inc: { paidAmount: a.amount } }, { session });
        } else if (a.docType === "SupplierBill") {
          const bill = await SupplierBill.findById(a.doc).session(session);
          const paid = r2(bill.paidAmount + a.amount - a.tds);
          const tds = r2(bill.tdsAmount + a.tds);
          const left = r2(bill.totals.grand - paid - tds - bill.debitedAmount);
          await SupplierBill.updateOne({ _id: bill._id }, { $set: { paidAmount: paid, tdsAmount: tds, status: left <= 0.005 ? "paid" : "part_paid" } }, { session });
        } else {
          const e = await Expense.findById(a.doc).session(session);
          const paid = r2(e.paidAmount + a.amount);
          const done = r2(e.totals.grand - paid) <= 0.005;
          await Expense.updateOne({ _id: e._id }, {
            $set: { paidAmount: paid, ...(done ? { status: "paid", paidFrom: account._id, paidAt: date } : {}) },
            $push: { fingerprints: fp(ACTION_CODES.EXPENSE_PAID, e, req, { voucherNo: number, amount: a.amount }) },
          }, { session });
        }
      }
      if (party) {
        const settled = r2(amount + tdsAmount);
        await partyLedger.post({
          partyType, party: party._id, date, docType: "Payment", doc: _id, docNo: number,
          ...(kind === "receipt" ? { credit: settled } : { debit: settled }),
          narration: data.narration || `${kind === "receipt" ? "Received" : "Paid"} by ${b.mode}${data.reference ? ` · ${data.reference}` : ""}`,
        }, session);
      }
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await Payment.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
      if (dup) return { voucher: dup, replay: true };
    }
    throw err;
  }
  return { voucher, replay: false };
}

router.post("/payments", catchAsyncErrors(async (req, res, next) => {
  let out;
  try { out = await createVoucher(req.body || {}, req); } catch (err) { if (err instanceof ErrorHandler) return next(err); throw err; }
  const v = out.voucher.toObject ? out.voucher.toObject() : out.voucher;
  res.status(out.replay ? 200 : 201).json({ success: true, payment: v, ...(out.replay ? { replay: true } : {}) });
}));

router.post("/payments/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Voucher not found", 404));
  const v = await Payment.findById(req.params.id);
  if (!v) return next(new ErrorHandler("Voucher not found", 404));
  if (v.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  const cancel = { reason, at: new Date(), by: req.user?._id };
  const mark = fp(ACTION_CODES.PAYMENT_CANCELLED, v, req, { voucherNo: v.voucherNo, reason });
  await withTxn(async (session) => {
    await Payment.updateOne({ _id: v._id }, { $set: { status: "cancelled", cancel }, $push: { fingerprints: mark } }, { session });
    for (const a of v.allocations) {
      if (a.docType === "Invoice") {
        await Invoice.updateOne({ _id: a.doc }, { $inc: { paidAmount: -a.amount } }, { session });
      } else if (a.docType === "SupplierBill") {
        const bill = await SupplierBill.findById(a.doc).session(session);
        if (bill) {
          const paid = r2(bill.paidAmount - (a.amount - a.tds));
          const tds = r2(bill.tdsAmount - a.tds);
          const left = r2(bill.totals.grand - paid - tds - bill.debitedAmount);
          const status = bill.status === "cancelled" ? "cancelled" : left <= 0.005 ? "paid" : (paid + tds + bill.debitedAmount > 0 ? "part_paid" : "open");
          await SupplierBill.updateOne({ _id: bill._id }, { $set: { paidAmount: paid, tdsAmount: tds, status } }, { session });
        }
      } else {
        const e = await Expense.findById(a.doc).session(session);
        if (e) {
          const paid = r2(e.paidAmount - a.amount);
          const update = { $set: { paidAmount: paid } };
          if (e.status === "paid") { update.$set.status = "approved"; update.$unset = { paidFrom: 1, paidAt: 1 }; }
          await Expense.updateOne({ _id: e._id }, update, { session });
        }
      }
    }
    await partyLedger.reverse("Payment", v._id, session);
  });
  res.json({ success: true, payment: await Payment.findById(v._id).select("-attachments.data").lean() });
}));

// ══════════════════════════════════════════════════════════════════
//  LEDGERS AND OVERVIEW
// ══════════════════════════════════════════════════════════════════
router.get("/statement", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (!["customer", "supplier"].includes(partyType)) return next(new ErrorHandler("partyType must be customer or supplier", 400));
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  let from, to;
  try {
    from = readDate(req.query.from, "from");
    to = readDate(req.query.to, "to");
    if (to) to = new Date(to.getTime() + DAY - 1);
  } catch (err) { return next(err); }
  const Model = partyType === "customer" ? Customer : Supplier;
  const party = await Model.findById(req.query.party).select("name gstin").lean();
  if (!party) return next(new ErrorHandler("Party not found", 404));
  const s = await partyLedger.statement(partyType, party._id, { from, to });
  const open = partyType === "customer" ? await outstanding.receivables({ customer: party._id }) : await outstanding.payables({ supplier: party._id });
  res.json({ success: true, party: { _id: party._id, name: party.name, gstin: party.gstin || "" }, partyType, ...s, open: outstanding.totals(open) });
}));

router.get("/outstanding", catchAsyncErrors(async (req, res, next) => {
  const type = req.query.type === "payable" ? "payable" : req.query.type === "receivable" ? "receivable" : null;
  if (!type) return next(new ErrorHandler("type must be receivable or payable", 400));
  const party = isId(req.query.party) ? req.query.party : undefined;
  const rows = type === "receivable" ? await outstanding.receivables({ customer: party }) : await outstanding.payables({ supplier: party });
  res.json({ success: true, type, rows, byParty: outstanding.byParty(rows), totals: outstanding.totals(rows), buckets: outstanding.BUCKETS });
}));

router.get("/overview", catchAsyncErrors(async (_req, res) => {
  await ensureSeed();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [recv, pay, accounts, pendingExpenses, monthExpenses, monthInvoices, monthBills, recentPayments] = await Promise.all([
    outstanding.receivables(),
    outstanding.payables(),
    BankAccount.find({ active: true }).lean(),
    Expense.countDocuments({ status: "pending" }),
    Expense.aggregate([{ $match: { status: { $in: ["approved", "paid"] }, date: { $gte: monthStart } } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: { status: "issued", invoiceDate: { $gte: monthStart } } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, tax: { $sum: "$totals.tax" }, count: { $sum: 1 } } }]),
    SupplierBill.aggregate([{ $match: { status: { $ne: "cancelled" }, billDate: { $gte: monthStart } } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, itc: { $sum: "$itc.amount" }, count: { $sum: 1 } } }]),
    Payment.find({ status: "posted" }).select("kind voucherNo date partyName amount mode accountName").sort({ date: -1, createdAt: -1 }).limit(8).lean(),
  ]);
  const sums = await Payment.aggregate([
    { $match: { status: "posted" } },
    { $group: { _id: "$account", receipts: { $sum: { $cond: [{ $eq: ["$kind", "receipt"] }, "$amount", 0] } }, payments: { $sum: { $cond: [{ $eq: ["$kind", "payment"] }, "$amount", 0] } } } },
  ]);
  const by = new Map(sums.map((s) => [String(s._id), s]));
  res.json({
    success: true,
    receivables: { ...outstanding.totals(recv), top: outstanding.byParty(recv).slice(0, 5) },
    payables: { ...outstanding.totals(pay), top: outstanding.byParty(pay).slice(0, 5) },
    accounts: accounts.map((a) => { const s = by.get(String(a._id)) || { receipts: 0, payments: 0 }; return { _id: a._id, name: a.name, kind: a.kind, balance: r2((a.openingBalance || 0) + s.receipts - s.payments) }; }),
    pendingExpenses,
    month: {
      from: monthStart,
      expenses: { amount: r2(monthExpenses[0]?.amount || 0), count: monthExpenses[0]?.count || 0 },
      sales: { amount: r2(monthInvoices[0]?.amount || 0), outputTax: r2(monthInvoices[0]?.tax || 0), count: monthInvoices[0]?.count || 0 },
      purchases: { amount: r2(monthBills[0]?.amount || 0), inputCredit: r2(monthBills[0]?.itc || 0), count: monthBills[0]?.count || 0 },
    },
    recentPayments,
  });
}));

router.post("/ledger/rebuild", isAdmin("admin"), catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, rows: await partyLedger.rebuild() });
}));

// ══════════════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════════════
function rangeOf(req) {
  const from = readDate(req.query.from, "from") || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let to = readDate(req.query.to, "to") || new Date();
  to = new Date(to.getTime() + DAY - 1);
  return { from, to };
}

/** Output tax from sales, input credit from purchases and expenses, by rate. */
router.get("/reports/gst", catchAsyncErrors(async (req, res, next) => {
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const byRate = (docs, lineKey = "lines") => {
    const out = new Map();
    for (const d of docs) for (const l of d[lineKey] || []) {
      const k = Number(l.gstPercent) || 0;
      const g = out.get(k) || { rate: k, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
      g.taxable = r2(g.taxable + l.taxable); g.cgst = r2(g.cgst + l.cgst); g.sgst = r2(g.sgst + l.sgst); g.igst = r2(g.igst + l.igst);
      g.tax = r2(g.cgst + g.sgst + g.igst);
      out.set(k, g);
    }
    return [...out.values()].sort((a, b) => a.rate - b.rate);
  };
  const sum = (rows) => rows.reduce((t, g) => ({ taxable: r2(t.taxable + g.taxable), cgst: r2(t.cgst + g.cgst), sgst: r2(t.sgst + g.sgst), igst: r2(t.igst + g.igst), tax: r2(t.tax + g.tax) }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 });
  const [invoices, creditNotes, bills, debitNotes, expenses] = await Promise.all([
    Invoice.find({ status: "issued", invoiceDate: { $gte: r.from, $lte: r.to } }).select("lines").lean(),
    AccountNote.find({ kind: "credit", status: "issued", date: { $gte: r.from, $lte: r.to } }).select("lines").lean(),
    SupplierBill.find({ status: { $ne: "cancelled" }, "itc.eligible": true, billDate: { $gte: r.from, $lte: r.to } }).select("lines").lean(),
    AccountNote.find({ kind: "debit", status: "issued", date: { $gte: r.from, $lte: r.to } }).select("lines").lean(),
    Expense.find({ status: { $in: ["approved", "paid"] }, "itc.eligible": true, date: { $gte: r.from, $lte: r.to } }).select("lines").lean(),
  ]);
  const output = { sales: byRate(invoices), creditNotes: byRate(creditNotes) };
  const input = { purchases: byRate(bills), debitNotes: byRate(debitNotes), expenses: byRate(expenses) };
  const outputTotal = sum(output.sales); const cnTotal = sum(output.creditNotes);
  const inputTotal = sum(input.purchases); const dnTotal = sum(input.debitNotes); const expTotal = sum(input.expenses);
  const netOutput = { cgst: r2(outputTotal.cgst - cnTotal.cgst), sgst: r2(outputTotal.sgst - cnTotal.sgst), igst: r2(outputTotal.igst - cnTotal.igst) };
  const netInput = { cgst: r2(inputTotal.cgst - dnTotal.cgst + expTotal.cgst), sgst: r2(inputTotal.sgst - dnTotal.sgst + expTotal.sgst), igst: r2(inputTotal.igst - dnTotal.igst + expTotal.igst) };
  res.json({
    success: true, from: r.from, to: r.to, output, input,
    totals: { output: outputTotal, creditNotes: cnTotal, purchases: inputTotal, debitNotes: dnTotal, expenses: expTotal, netOutput, netInput,
      payable: { cgst: r2(netOutput.cgst - netInput.cgst), sgst: r2(netOutput.sgst - netInput.sgst), igst: r2(netOutput.igst - netInput.igst) } },
    counts: { invoices: invoices.length, creditNotes: creditNotes.length, bills: bills.length, debitNotes: debitNotes.length, expenses: expenses.length },
  });
}));

/** What was deducted, from whom, under which section. */
router.get("/reports/tds", catchAsyncErrors(async (req, res, next) => {
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const vouchers = await Payment.find({ status: "posted", kind: "payment", "tds.amount": { $gt: 0 }, date: { $gte: r.from, $lte: r.to } })
    .select("voucherNo date supplier partyName amount tds allocations").sort({ date: 1 }).lean();
  const byDeductee = new Map();
  for (const v of vouchers) {
    const key = `${v.supplier || v.partyName}|${v.tds.section}`;
    const g = byDeductee.get(key) || { supplier: v.supplier, partyName: v.partyName, section: v.tds.section, rate: v.tds.rate, gross: 0, tds: 0, vouchers: [] };
    const gross = r2(v.amount + v.tds.amount);
    g.gross = r2(g.gross + gross); g.tds = r2(g.tds + v.tds.amount);
    g.vouchers.push({ _id: v._id, voucherNo: v.voucherNo, date: v.date, gross, tds: v.tds.amount, docs: v.allocations.map((a) => a.docNo) });
    byDeductee.set(key, g);
  }
  const rows = [...byDeductee.values()];
  res.json({ success: true, from: r.from, to: r.to, rows, total: { gross: r2(rows.reduce((s, g) => s + g.gross, 0)), tds: r2(rows.reduce((s, g) => s + g.tds, 0)) } });
}));

router.get("/reports/expenses", catchAsyncErrors(async (req, res, next) => {
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const rows = await Expense.aggregate([
    { $match: { status: { $in: ["approved", "paid"] }, date: { $gte: r.from, $lte: r.to } } },
    { $group: { _id: "$category", categoryName: { $first: "$categoryName" }, amount: { $sum: "$totals.grand" }, taxable: { $sum: "$totals.taxable" }, itc: { $sum: "$itc.amount" }, count: { $sum: 1 }, paid: { $sum: "$paidAmount" } } },
    { $sort: { amount: -1 } },
  ]);
  const bills = await SupplierBill.aggregate([
    { $match: { status: { $ne: "cancelled" }, kind: "service", billDate: { $gte: r.from, $lte: r.to } } },
    { $group: { _id: "$category", amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } },
  ]);
  const cats = await ExpenseCategory.find({}).select("name").lean();
  const name = new Map(cats.map((c) => [String(c._id), c.name]));
  res.json({
    success: true, from: r.from, to: r.to,
    rows: rows.map((x) => ({ category: x._id, categoryName: x.categoryName || name.get(String(x._id)) || "—", amount: r2(x.amount), taxable: r2(x.taxable), itc: r2(x.itc), count: x.count, unpaid: r2(x.amount - x.paid) })),
    serviceBills: bills.map((x) => ({ category: x._id, categoryName: name.get(String(x._id)) || "Uncategorised", amount: r2(x.amount), count: x.count })),
    total: r2(rows.reduce((s, x) => s + x.amount, 0)),
  });
}));

/** The cash / bank book for one account: every voucher with a running balance. */
router.get("/reports/cashbook", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.query.account)) return next(new ErrorHandler("account is required", 400));
  const account = await BankAccount.findById(req.query.account).lean();
  if (!account) return next(new ErrorHandler("Account not found", 404));
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const before = await Payment.aggregate([
    { $match: { status: "posted", account: account._id, date: { $lt: r.from } } },
    { $group: { _id: null, receipts: { $sum: { $cond: [{ $eq: ["$kind", "receipt"] }, "$amount", 0] } }, payments: { $sum: { $cond: [{ $eq: ["$kind", "payment"] }, "$amount", 0] } } } },
  ]);
  const opening = r2((account.openingBalance || 0) + (before[0]?.receipts || 0) - (before[0]?.payments || 0));
  const vouchers = await Payment.find({ status: "posted", account: account._id, date: { $gte: r.from, $lte: r.to } })
    .select("kind voucherNo date partyName amount mode reference narration allocations").sort({ date: 1, createdAt: 1 }).lean();
  let running = opening;
  const rows = vouchers.map((v) => {
    running = r2(running + (v.kind === "receipt" ? v.amount : -v.amount));
    return { ...v, inflow: v.kind === "receipt" ? v.amount : 0, outflow: v.kind === "payment" ? v.amount : 0, balance: running };
  });
  res.json({ success: true, account: { _id: account._id, name: account.name, kind: account.kind }, from: r.from, to: r.to, opening, rows, closing: running,
    inflow: r2(rows.reduce((s, x) => s + x.inflow, 0)), outflow: r2(rows.reduce((s, x) => s + x.outflow, 0)) });
}));

/** Everything dated one day. */
router.get("/reports/daybook", catchAsyncErrors(async (req, res, next) => {
  let day;
  try { day = readDate(req.query.date, "date", new Date()); } catch (err) { return next(err); }
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const to = new Date(from.getTime() + DAY - 1);
  const range = { $gte: from, $lte: to };
  const [invoices, bills, expenses, notes, payments] = await Promise.all([
    Invoice.find({ status: "issued", invoiceDate: range }).select("invoiceNumber buyer.name totals.grand orderNo").lean(),
    SupplierBill.find({ status: { $ne: "cancelled" }, billDate: range }).select("billNo supplierName supplierBillNo totals.grand").lean(),
    Expense.find({ status: { $ne: "cancelled" }, date: range }).select("expenseNo categoryName description payeeName totals.grand status").lean(),
    AccountNote.find({ status: "issued", date: range }).select("kind noteNo partyName totals.grand against.docNo reason").lean(),
    Payment.find({ status: "posted", date: range }).select("kind voucherNo partyName amount mode accountName tds.amount allocations.docNo").lean(),
  ]);
  res.json({ success: true, date: from, invoices, bills, expenses, notes, payments,
    totals: {
      sales: r2(invoices.reduce((s, x) => s + (x.totals?.grand || 0), 0)), purchases: r2(bills.reduce((s, x) => s + (x.totals?.grand || 0), 0)),
      expenses: r2(expenses.reduce((s, x) => s + (x.totals?.grand || 0), 0)),
      received: r2(payments.filter((p) => p.kind === "receipt").reduce((s, x) => s + x.amount, 0)),
      paid: r2(payments.filter((p) => p.kind === "payment").reduce((s, x) => s + x.amount, 0)),
    } });
}));

// ══════════════════════════════════════════════════════════════════
//  AI: A BILL PHOTO INTO A DRAFT
// ══════════════════════════════════════════════════════════════════
//  POST /scan  multipart "files" (1–4 photos / PDF) → the fields a
//  draft bill or expense needs, the supplier on file it matches (by
//  GSTIN, then by name), and that supplier's POs with unbilled
//  receipts. Nothing is saved: the form opens filled in, the person
//  checks every figure, and what they save is a bill like any other.
router.post("/scan", keepRequestContext(scanUpload.array("files", 4)), catchAsyncErrors(async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return next(new ErrorHandler("Attach the bill — a photo (JPEG, PNG) or a PDF", 400));
  let read;
  const startedAt = Date.now();
  try {
    read = await readBill(files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })));
  } catch (err) {
    if (err.code === "ANTHROPIC_KEY_MISSING") return next(new ErrorHandler("Bill scanning is not configured on this server (no AI key).", 503));
    if (err.code) return next(new ErrorHandler(err.message, 400));
    await aiLedger.record({ surface: "bill-ocr", model: "?", promptVersion: promptVersion("bill-ocr"), latencyMs: Date.now() - startedAt, error: err.message });
    return next(new ErrorHandler(`The bill could not be read: ${err.message}`, 502));
  }
  const suggestionId = await aiLedger.record({
    surface: "bill-ocr", model: read.model, promptVersion: promptVersion("bill-ocr"),
    proposed: { kind: read.kind, supplierName: read.supplierName, supplierGstin: read.supplierGstin, billNo: read.billNo, billDate: read.billDate, lines: read.lines, totals: read.totals, confidence: read.confidence },
    latencyMs: read.latencyMs, usage: read.usage,
  });
  if (read.problem) {
    return res.json({ success: true, read, supplier: null, purchaseOrders: [], aiSuggestion: suggestionId });
  }
  // Who it is, on file: the GSTIN settles it; a name is a guess to confirm.
  let supplier = null;
  let matchedBy = null;
  if (read.supplierGstin) {
    supplier = await Supplier.findOne({ gstin: read.supplierGstin }).select("name gstin").lean();
    if (supplier) matchedBy = "gstin";
  }
  if (!supplier && read.supplierName) {
    const words = read.supplierName.split(/\s+/).filter((w) => w.length >= 3).slice(0, 3);
    if (words.length) {
      const re = new RegExp(words.map((w) => `(?=.*${escapeRegex(w)})`).join(""), "i");
      supplier = await Supplier.findOne({ name: re }).select("name gstin").lean();
      if (supplier) matchedBy = "name";
    }
  }
  const already = read.billNo && supplier
    ? await SupplierBill.findOne({ supplier: supplier._id, supplierBillNo: read.billNo, status: { $ne: "cancelled" } }).select("billNo").lean()
    : null;
  // The supplier's POs with something still to bill.
  let purchaseOrders = [];
  if (supplier) {
    const pos = await PurchaseOrder.find({ supplier: supplier._id, status: { $ne: "Cancelled" } }).select("poNo date status").sort({ date: -1 }).limit(10).lean();
    const billed = new Set((await SupplierBill.find({ purchaseOrder: { $in: pos.map((p) => p._id) }, status: { $ne: "cancelled" } }).select("inwards").lean()).flatMap((b) => (b.inwards || []).map(String)));
    for (const po of pos) {
      const inwards = await MaterialInward.find({ purchaseOrder: po._id }).select("quantity").lean();
      const unbilled = inwards.filter((i) => !billed.has(String(i._id)));
      purchaseOrders.push({ _id: po._id, poNo: po.poNo, date: po.date, status: po.status, receipts: inwards.length, unbilledReceipts: unbilled.length });
    }
  }
  res.json({ success: true, read, supplier: supplier ? { ...supplier, matchedBy } : null, alreadyEntered: already ? already.billNo : null, purchaseOrders, aiSuggestion: suggestionId });
}));

// ══════════════════════════════════════════════════════════════════
//  AI: A BANK STATEMENT MATCHED TO THE BOOKS
// ══════════════════════════════════════════════════════════════════
//  POST /bank/statement       multipart "file" (CSV / Excel) + account
//  POST /bank/statement/post  the lines the person confirmed → vouchers
router.post("/bank/statement", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  if (!req.file) return next(new ErrorHandler("Attach the statement as CSV or Excel", 400));
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  const account = await BankAccount.findById(req.body.account).lean();
  if (!account) return next(new ErrorHandler("Account not found", 404));
  let rows;
  try {
    rows = await bankStatement.parse(req.file.buffer, req.file.mimetype, req.file.originalname);
  } catch (err) {
    return next(new ErrorHandler(err.message, 400));
  }
  if (!rows.length) return next(new ErrorHandler("No transactions found in the file", 400));
  const matched = await bankStatement.match(rows, account._id, { useModel: req.body?.useModel !== "false" });
  const counts = { recorded: 0, matched: 0, unmatched: 0 };
  for (const r of matched) counts[r.status] = (counts[r.status] || 0) + 1;
  res.json({ success: true, account: { _id: account._id, name: account.name }, rows: matched, counts, file: req.file.originalname });
}));

router.post("/bank/statement/post", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return next(new ErrorHandler("No lines to post", 400));
  if (rows.length > 500) return next(new ErrorHandler("At most 500 lines at a time", 400));
  const results = [];
  for (const [i, r] of rows.entries()) {
    try {
      const kind = r.direction === "in" ? "receipt" : "payment";
      const partyType = r.partyType === "customer" || r.partyType === "supplier" ? r.partyType : "other";
      const { voucher, replay } = await createVoucher({
        kind, date: r.date, partyType,
        ...(partyType === "customer" ? { customer: r.party } : partyType === "supplier" ? { supplier: r.party } : { partyName: r.partyName || r.narration || "Bank" }),
        amount: r.amount, mode: r.mode || "bank", account: req.body.account, reference: r.ref || "",
        allocations: Array.isArray(r.allocations) ? r.allocations.map((a) => ({ docType: a.docType, doc: a.doc, amount: a.amount })) : [],
        narration: r.narration || "", source: "statement", statementLine: `${r.date || ""} ${r.narration || ""}`.trim().slice(0, 200),
        requestId: r.requestId,
      }, req);
      results.push({ index: i, ok: true, voucherNo: voucher.voucherNo, _id: voucher._id, replay: !!replay });
    } catch (err) {
      results.push({ index: i, ok: false, error: err.message });
    }
  }
  res.json({ success: true, results, posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
}));

// ══════════════════════════════════════════════════════════════════
//  AI: COLLECTION FOLLOW-UPS
// ══════════════════════════════════════════════════════════════════
router.get("/collections", catchAsyncErrors(async (_req, res) => {
  const rows = await collections.overdue();
  res.json({ success: true, rows, total: r2(rows.reduce((s, r) => s + r.overdue, 0)), whatsapp: whatsappConfigured() });
}));

router.post("/collections/draft", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.body?.customer)) return next(new ErrorHandler("customer is required", 400));
  const entry = (await collections.overdue()).find((r) => String(r.party) === String(req.body.customer));
  if (!entry) return next(new ErrorHandler("Nothing overdue for this customer", 404));
  const settings = await getDocumentSettings();
  const out = await collections.draft(entry, { company: settings.companyName || "Balu Elastics", tone: req.body?.tone === "firm" ? "firm" : "gentle" });
  res.json({ success: true, ...out, to: collections.e164(entry.contact.accountantPhone || entry.contact.phone), entry });
}));

router.post("/collections/send", catchAsyncErrors(async (req, res, next) => {
  const to = collections.e164(req.body?.to);
  const message = String(req.body?.message || "").trim();
  if (!to) return next(new ErrorHandler("A phone number is required", 400));
  if (message.length < 20) return next(new ErrorHandler("The message is too short to send", 400));
  const result = await sendWhatsApp(to, message.slice(0, 1500));
  res.json({ success: true, ...result, to });
}));

module.exports = router;
module.exports.createVoucher = createVoucher;
