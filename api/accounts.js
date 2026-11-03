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
const Contra          = require("../models/Contra");
const Invoice         = require("../models/Invoice");
const Supplier        = require("../models/Supplier");
const Customer        = require("../models/Customer");
const PurchaseOrder   = require("../models/PurchaseOrder");
const MaterialInward  = require("../models/MaterialInward");
const RawMaterial     = require("../models/RawMaterial");
const BankStatement   = require("../models/BankStatement");
const reconcile       = require("../services/reconcile");
const { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } = require("../models/accountsShared");

const {
  DAY, isId, r2, readDate, reasonFrom, fp, withTxn, paging,
} = require("../services/accountsHelpers");
const settle = require("../services/settle");
const billChecks = require("../services/billChecks");
const attachments = require("../services/attachments");
const { getSettings: getBooksSettings } = require("../services/booksLock");
const credits = require("../services/credits");
const gstSummary = require("../services/gstSummary");
const bankBalances = require("../services/bankBalances");
const { assertOpen } = require("../services/booksLock");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4 } });

// ── Helpers ───────────────────────────────────────────────────────
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


// ══════════════════════════════════════════════════════════════════
//  MASTERS
// ══════════════════════════════════════════════════════════════════
router.get("/bank-accounts", catchAsyncErrors(async (_req, res) => {
  await ensureSeed();
  const accounts = await BankAccount.find({}).sort({ isDefault: -1, name: 1 }).lean();
  // The book balance per account: opening + money in − money out, contras both ways.
  res.json({ success: true, accounts: await bankBalances.withBalances(accounts) });
}));

const ACCOUNT_FIELDS = ["name", "kind", "bankName", "accountNo", "ifsc", "upiId", "openingBalance", "openingDate", "float", "active", "isDefault", "tallyLedger"];
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

const CATEGORY_FIELDS = ["name", "ledger", "itcEligible", "approvalAbove", "tdsSection", "active", "claimDailyLimit"];
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
    await assertOpen(billDate, req);
    dueDate = readDate(b.dueDate, "dueDate", new Date(billDate.getTime() + (supplier.paymentTermsDays ?? 30) * DAY));
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
  const reverseCharge = !!b.reverseCharge;
  let gst;
  try { gst = billChecks.gstRules({ supplier, priced: p, reverseCharge, itcEligible }); } catch (err) { return next(err); }
  // The three-way match: rate against the PO, quantity against what was received.
  const tolerance = (await getBooksSettings()).bills?.rateVariancePercent ?? 2;
  const variance = await billChecks.variance({ lines: p.lines, po: po?._id, inwards: inwardIds, tolerancePercent: tolerance });
  const varianceNote = String(b.varianceNote || "").trim();
  if (variance.lines.length && varianceNote.length < 8) {
    const err = new ErrorHandler(`This bill does not match the PO or the receipts (₹${variance.total.toFixed(2)} more than expected) — add a note saying why it is right`, 409);
    err.code = "BILL_VARIANCE";
    err.details = variance;
    return next(err);
  }
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
    supplyType: p.supplyType, lines: p.lines, totals: gst.totals,
    reverseCharge, ...(gst.rcm ? { rcm: gst.rcm } : {}),
    itc: { eligible: itcEligible, amount: gst.itcAmount },
    ...(variance.lines.length ? { variance: { ...variance, note: varianceNote.slice(0, 300) } } : {}),
    tds, notes: String(b.notes || "").trim().slice(0, 500), source: b.source === "scan" ? "scan" : "manual",
    aiSuggestion: isId(b.aiSuggestion) ? b.aiSuggestion : undefined, createdBy: req.user?._id,
    fingerprints: [fp(ACTION_CODES.BILL_CREATED, { _id }, req, { billNo: number, supplierBillNo, supplier: supplier.name, grand: gst.totals.grand, ...(variance.lines.length ? { variance: variance.total, note: varianceNote } : {}), ...(reverseCharge ? { reverseCharge: true } : {}) })],
  };
  let doc;
  try {
    await withTxn(async (session) => {
      [doc] = await SupplierBill.create([data], { session });
      await partyLedger.post({ partyType: "supplier", party: supplier._id, date: billDate, docType: "SupplierBill", doc: _id, docNo: number, credit: gst.totals.grand, narration: `Bill ${supplierBillNo}${po ? ` · PO #${po.poNo}` : ""}${reverseCharge ? " · reverse charge" : ""}` }, session);
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
  // What the person kept of the scan: the AI's accuracy, field by field.
  if (data.aiSuggestion) {
    aiLedger.settle(data.aiSuggestion, {
      accepted: { supplierGstin: data.supplierGstin, billNo: data.supplierBillNo, billDate: billDate.toISOString().slice(0, 10), lines: data.lines.map((l) => ({ description: l.description, hsn: l.hsn, quantity: l.quantity, unit: l.unit, rate: l.rate, gstPercent: l.gstPercent })), totals: { taxable: data.totals.taxable, grand: data.totals.grand } },
      decidedBy: req.user?._id, expectSurface: "bill-ocr", ignoreMissing: true,
    }).catch(() => {});
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
  try { reason = reasonFrom(req); await assertOpen(bill.billDate, req, { cancelling: true }); } catch (err) { return next(err); }
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
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  try {
    const attachment = await attachments.attach(ATTACHABLE[req.params.kind], req.params.kind, req.params.id, req.file);
    res.status(201).json({ success: true, attachment });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
}));

router.get("/:kind(bills|expenses|notes|payments)/:id/attachments/:aid", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id) || !isId(req.params.aid)) return next(new ErrorHandler("Not found", 404));
  const f = await attachments.read(ATTACHABLE[req.params.kind], req.params.id, req.params.aid);
  if (!f) return next(new ErrorHandler("Not found", 404));
  res.setHeader("Content-Type", f.contentType);
  res.setHeader("Content-Disposition", `inline; filename="${(f.filename || "attachment").replace(/"/g, "")}"`);
  res.send(f.buffer);
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
  if (expense.status !== "approved") throw new ErrorHandler(`Only an approved expense can be paid (this one is ${expense.status})`, 409);
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
  await settle.apply("Expense", expense._id, { paidAmount: amount }, session, { docNo: expense.expenseNo, extraSet: { paidFrom: acct._id, paidAt: when } });
  await Expense.updateOne({ _id: expense._id }, { $push: { fingerprints: fp(ACTION_CODES.EXPENSE_PAID, expense, req, { voucherNo: number, amount, account: acct.name }) } }, { session });
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
  let date, lines, dueDate;
  try {
    date = readDate(b.date, "date", new Date());
    await assertOpen(date, req);
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
  try {
    dueDate = readDate(b.dueDate, "dueDate", new Date(date.getTime() + (supplier ? (supplier.paymentTermsDays ?? 30) : 0) * DAY));
  } catch (err) { return next(err); }
  const payeeGstin = String(b.payeeGstin || supplier?.gstin || "").trim().toUpperCase();
  const p = priced(lines, await sellerStateCode(), stateCodeFromGstin(payeeGstin));
  const itcEligible = b.itcEligible === undefined ? !!category.itcEligible && p.totals.tax > 0 : !!b.itcEligible;
  const needsApproval = category.approvalAbove === 0 || p.totals.grand > category.approvalAbove;

  const { financialYear, sequence, number } = await allocate(Expense, "EXP", { at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, expenseNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined,
    date, dueDate, category: category._id, categoryName: category.name, description: description.slice(0, 200),
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
  if (data.aiSuggestion) {
    aiLedger.settle(data.aiSuggestion, {
      accepted: { supplierGstin: payeeGstin, billNo: data.refNo, billDate: date.toISOString().slice(0, 10), lines: data.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, gstPercent: l.gstPercent })), totals: { taxable: data.totals.taxable, grand: data.totals.grand } },
      decidedBy: req.user?._id, expectSurface: "bill-ocr", ignoreMissing: true,
    }).catch(() => {});
  }
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
  try { date = readDate(req.body?.date, "date", new Date()); await assertOpen(date, req); } catch (err) { return next(err); }
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
  try { reason = reasonFrom(req); await assertOpen(e.date, req, { cancelling: true }); } catch (err) { return next(err); }
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
//  credit → customer, against an invoice: lowers what they owe
//  debit  → supplier, against a bill:     lowers what we owe
//  debit  → customer, against an invoice: raises what they owe
//
//  A note that lowers is applied to its document up to what that still
//  owes; the rest is unapplied credit on the party, applied later
//  (POST /credits/apply). It can never come to more than the document
//  was for, less the notes already against it.
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
    q.$or = [{ noteNo: re }, { partyName: re }, { "against.docNo": re }, { reason: re }, { partyNoteNo: re }];
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
  // A credit note is to a customer; a debit note to a supplier unless it says customer.
  const partyType = kind === "credit" ? "customer" : b.partyType === "customer" ? "customer" : "supplier";
  if (b.requestId) {
    const dup = await AccountNote.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return res.status(200).json({ success: true, note: dup, replay: true });
  }
  const reason = String(b.reason || "").trim();
  if (reason.length < 3) return next(new ErrorHandler("reason is required", 400));
  if (!isId(b.against?.doc)) return next(new ErrorHandler("against.doc is required", 400));
  const docType = partyType === "customer" ? "Invoice" : "SupplierBill";
  const target = docType === "Invoice" ? await Invoice.findById(b.against.doc).lean() : await SupplierBill.findById(b.against.doc).lean();
  if (!target) return next(new ErrorHandler(`${docType === "Invoice" ? "Invoice" : "Bill"} not found`, 404));
  if (docType === "Invoice" && target.status !== "issued") return next(new ErrorHandler("That invoice is cancelled", 409));
  if (docType === "SupplierBill" && target.status === "cancelled") return next(new ErrorHandler("That bill is cancelled", 409));
  let date, lines;
  try {
    date = readDate(b.date, "date", new Date());
    await assertOpen(date, req);
    lines = readLines(b.lines, { defaultGst: target.lines?.[0]?.gstPercent ?? 5 });
  } catch (err) { return next(err); }
  const partyState = docType === "Invoice" ? target.buyer?.stateCode : target.supplierStateCode;
  const p = priced(lines, await sellerStateCode(), partyState);
  const party = docType === "Invoice" ? target.customer : target.supplier;
  const partyName = docType === "Invoice" ? target.buyer?.name : target.supplierName;
  const partyGstin = docType === "Invoice" ? target.buyer?.gstin : target.supplierGstin;
  const docNo = docType === "Invoice" ? target.invoiceNumber : target.billNo;
  // Raises: a debit note to a customer. Lowers: the other two.
  const raises = kind === "debit" && partyType === "customer";
  let applied = p.totals.grand;
  if (!raises) {
    const earlier = await AccountNote.aggregate([
      { $match: { "against.doc": target._id, kind, status: "issued" } },
      { $group: { _id: null, total: { $sum: "$totals.grand" } } },
    ]);
    const room = r2((target.totals?.grand || 0) + (target.debitedAmount && docType === "Invoice" ? target.debitedAmount : 0) - (earlier[0]?.total || 0));
    if (p.totals.grand > room + 0.005) {
      return next(new ErrorHandler(`${docNo} is for ₹${r2(target.totals?.grand).toFixed(2)}${earlier[0]?.total ? ` and already has notes for ₹${r2(earlier[0].total).toFixed(2)}` : ""} — a note can be for at most ₹${Math.max(0, room).toFixed(2)}`, 400));
    }
    applied = Math.min(p.totals.grand, Math.max(0, settle.outstanding(docType, target)));
  }
  applied = r2(applied);
  const unapplied = r2(p.totals.grand - applied);

  const { financialYear, sequence, number } = await allocate(AccountNote, kind === "credit" ? "CN" : "DN", { extra: { kind }, at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, kind, noteNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
    partyType, customer: partyType === "customer" ? party : undefined, supplier: partyType === "supplier" ? party : undefined,
    partyName, partyGstin: partyGstin || "", partyNoteNo: String(b.partyNoteNo || "").trim().slice(0, 40),
    against: { docType, doc: target._id, docNo },
    reason: reason.slice(0, 200), supplyType: p.supplyType, lines: p.lines, totals: p.totals,
    applied, unapplied, notes: String(b.notes || "").trim().slice(0, 500), createdBy: req.user?._id,
  };
  data.fingerprints = [fp(ACTION_CODES.NOTE_ISSUED, { _id }, req, { noteNo: number, against: docNo, grand: p.totals.grand, unapplied, reason })];
  try {
    await withTxn(async (session) => {
      await AccountNote.create([data], { session });
      if (applied > 0) {
        const field = raises ? "debitedAmount" : docType === "Invoice" ? "creditedAmount" : "debitedAmount";
        await settle.apply(docType, target._id, { [field]: applied }, session, { docNo });
      }
      // Lowers what a customer owes / what we owe a supplier, or raises a customer's.
      const side = partyType === "customer" ? (raises ? "debit" : "credit") : "debit";
      await partyLedger.post({ partyType, party, date, docType: "AccountNote", doc: _id, docNo: number, [side]: p.totals.grand, narration: `${reason} (${docNo})` }, session);
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await AccountNote.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
      if (dup) return res.status(200).json({ success: true, note: dup, replay: true });
    }
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.status(201).json({ success: true, note: await AccountNote.findById(_id).select("-attachments.data").lean() });
}));

/** The field a note moves on the document it is applied to. */
function noteField(note, docType) {
  if (docType === "OpeningBalance") return "settledAmount";
  if (note.kind === "debit" && note.partyType === "customer") return "debitedAmount";
  return docType === "Invoice" ? "creditedAmount" : "debitedAmount";
}

router.post("/notes/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Note not found", 404));
  const note = await AccountNote.findById(req.params.id).lean();
  if (!note) return next(new ErrorHandler("Note not found", 404));
  if (note.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(note.date, req, { cancelling: true }); } catch (err) { return next(err); }
  const cancel = { reason, at: new Date(), by: req.user?._id };
  const mark = fp(ACTION_CODES.NOTE_CANCELLED, note, req, { noteNo: note.noteNo, reason });
  // What it applied to its own document — older notes carry no `applied`: all of it.
  const onAgainst = note.applied === undefined || note.applied === null || (note.applied === 0 && !note.unapplied) ? note.totals.grand : note.applied;
  try {
    await withTxn(async (session) => {
      await AccountNote.updateOne({ _id: note._id }, { $set: { status: "cancelled", cancel, unapplied: 0 }, $push: { fingerprints: mark } }, { session });
      if (onAgainst > 0) await settle.apply(note.against.docType, note.against.doc, { [noteField(note, note.against.docType)]: -onAgainst }, session);
      for (const a of note.applications || []) {
        await settle.apply(a.docType, a.doc, { [noteField(note, a.docType)]: -a.amount }, session);
      }
      await partyLedger.reverse("AccountNote", note._id, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, note: await AccountNote.findById(note._id).select("-attachments.data").lean() });
}));

// ══════════════════════════════════════════════════════════════════
//  RECEIPTS AND PAYMENTS
// ══════════════════════════════════════════════════════════════════

/** The open documents a voucher for this party could settle, and the credits it has. */
router.get("/payments/open-docs", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  if (partyType !== "customer" && partyType !== "supplier") return next(new ErrorHandler("partyType must be customer or supplier", 400));
  const rows = partyType === "customer" ? await outstanding.receivables({ customer: req.query.party }) : await outstanding.payables({ supplier: req.query.party });
  const balance = (await partyLedger.balances(partyType, [req.query.party])).get(String(req.query.party)) || 0;
  res.json({ success: true, docs: rows, balance, credits: await credits.openFor(partyType, req.query.party) });
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

// What a short payment can be settled by, besides the money.
const ADJUSTMENTS = {
  receipt: ["bank_charges", "discount", "tds_by_customer", "round_off", "write_off"],
  payment: ["discount", "round_off", "write_off"],
};
const ADJUSTMENT_LABELS = { bank_charges: "Bank charges", discount: "Discount", tds_by_customer: "TDS deducted by customer", round_off: "Round off", write_off: "Written off" };

/** The field a voucher's allocation moves on each kind of document. */
const VOUCHER_FIELD = { Invoice: "paidAmount", SupplierBill: "paidAmount", Expense: "paidAmount", OpeningBalance: "settledAmount" };

/**
 * Post a receipt or payment voucher from a request body. Throws an
 * ErrorHandler for anything the caller got wrong; returns the voucher
 * (or the one a replayed requestId already made).
 *
 * Settled on the documents = money + TDS + adjustments. TDS on a
 * payment is deducted on each document's value net of GST.
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
  const date = readDate(b.date, "date", new Date());
  await assertOpen(date, req);

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

  // Adjustments: what settles the documents besides the money.
  const adjustments = [];
  for (const [i, a] of (Array.isArray(b.adjustments) ? b.adjustments : []).entries()) {
    const amt = r2(a?.amount);
    if (!amt) continue;
    if (!ADJUSTMENTS[kind].includes(a?.kind)) throw new ErrorHandler(`Adjustment ${i + 1}: a ${kind} cannot carry "${a?.kind || "?"}"`, 400);
    if (amt < 0) throw new ErrorHandler(`Adjustment ${i + 1}: amount must be more than 0`, 400);
    if (a.kind === "write_off" && req.user?.role !== "admin") throw new ErrorHandler("Only an admin can write an amount off", 403);
    adjustments.push({ kind: a.kind, label: ADJUSTMENT_LABELS[a.kind], amount: amt, note: String(a.note || "").trim().slice(0, 80) });
  }
  const adjTotal = r2(adjustments.reduce((s, a) => s + a.amount, 0));

  // The allocations: each names an open document of this party, for a
  // GROSS amount (what the document is settled by); TDS comes off it.
  const rawAlloc = Array.isArray(b.allocations) ? b.allocations : [];
  const allowedTypes = partyType === "customer" ? ["Invoice", "OpeningBalance"] : partyType === "supplier" ? ["SupplierBill", "Expense", "OpeningBalance"] : ["Expense"];
  const allocations = [];
  const seen = new Set();
  for (const [i, a] of rawAlloc.entries()) {
    if (!allowedTypes.includes(a?.docType)) throw new ErrorHandler(`Allocation ${i + 1}: a ${kind} to this party cannot settle a ${a?.docType || "?"}`, 400);
    if (!isId(a.doc)) throw new ErrorHandler(`Allocation ${i + 1}: doc is required`, 400);
    if (seen.has(String(a.doc))) throw new ErrorHandler(`Allocation ${i + 1}: the same document twice`, 400);
    seen.add(String(a.doc));
    const gross = r2(a.amount);
    if (!(gross > 0)) throw new ErrorHandler(`Allocation ${i + 1}: amount must be more than 0`, 400);
    const doc = await settle.load(a.docType, a.doc);
    if (!doc) throw new ErrorHandler(`Allocation ${i + 1}: document not found`, 404);
    const docNo = settle.numberOf(a.docType, doc);
    const docParty = settle.kindOf(a.docType).party(doc);
    if (party && String(docParty) !== String(party._id)) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} belongs to another party`, 400);
    // An expense to a supplier on file is paid to that supplier, so it is on their account.
    if (!party && docParty) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} is to a supplier on file — pay it as a payment to that supplier`, 400);
    if (a.docType === "OpeningBalance" && doc.partyType !== partyType) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} belongs to another party`, 400);
    if (!settle.isOpen(a.docType, doc)) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} is not open`, 409);
    const left = settle.outstanding(a.docType, doc);
    if (gross > left + 0.005) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} has only ${left.toFixed(2)} outstanding`, 400);
    let rate = 0;
    if (kind === "payment") rate = a.docType === "SupplierBill" ? (tdsRate || (doc.tds?.applicable ? doc.tds.rate : 0)) : tdsRate;
    const tdsBase = rate > 0 ? r2(gross * (a.docType === "OpeningBalance" ? 1 : outstanding.ratio(doc.totals))) : 0;
    const tds = rate > 0 ? r2(tdsBase * rate / 100) : 0;
    allocations.push({ docType: a.docType, doc: doc._id, docNo, amount: gross, tds, tdsBase });
  }
  const tdsAmount = r2(allocations.reduce((s, a) => s + a.tds, 0));
  const tdsBase = r2(allocations.reduce((s, a) => s + a.tdsBase, 0));
  const gross = r2(allocations.reduce((s, a) => s + a.amount, 0));
  if (adjTotal > 0 && adjTotal > gross + 0.005) throw new ErrorHandler("Adjustments settle documents — tick the documents they settle", 400);
  const settledTotal = r2(amount + tdsAmount + adjTotal);
  if (gross > settledTotal + 0.005) {
    throw new ErrorHandler(`The allocations need ${r2(gross - tdsAmount - adjTotal).toFixed(2)} but the voucher is for ${amount.toFixed(2)}`, 400);
  }
  const unallocated = r2(settledTotal - gross);

  const { financialYear, sequence, number } = await allocate(Payment, kind === "receipt" ? "RCT" : "PAY", { extra: { kind }, at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, kind, voucherNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
    partyType, customer: partyType === "customer" ? party._id : undefined, supplier: partyType === "supplier" ? party._id : undefined, partyName,
    amount, mode: b.mode, account: account._id, accountName: account.name, reference: String(b.reference || "").trim().slice(0, 60),
    tds: { section: tdsAmount > 0 ? tdsSection || "" : "", rate: tdsAmount > 0 ? tdsRate : 0, amount: tdsAmount, base: tdsBase },
    adjustments, allocations, unallocated, narration: String(b.narration || "").trim().slice(0, 300),
    source: b.source === "statement" ? "statement" : "manual", statementLine: String(b.statementLine || "").slice(0, 200),
    clearedOn: b.clearedOn ? readDate(b.clearedOn, "clearedOn") : undefined,
    createdBy: req.user?._id,
  };
  data.fingerprints = [fp(ACTION_CODES.PAYMENT_POSTED, { _id }, req, { voucherNo: number, amount, tds: tdsAmount, adjustments: adjTotal, docs: allocations.map((a) => a.docNo) })];

  let voucher;
  try {
    await withTxn(async (session) => {
      [voucher] = await Payment.create([data], { session });
      for (const a of allocations) {
        if (a.docType === "SupplierBill") {
          await settle.apply("SupplierBill", a.doc, { paidAmount: r2(a.amount - a.tds), tdsAmount: a.tds }, session, { docNo: a.docNo });
        } else if (a.docType === "Expense") {
          await settle.apply("Expense", a.doc, { paidAmount: a.amount }, session, { docNo: a.docNo, extraSet: { paidFrom: account._id, paidAt: date } });
          await Expense.updateOne({ _id: a.doc }, { $push: { fingerprints: fp(ACTION_CODES.EXPENSE_PAID, { _id: a.doc }, req, { voucherNo: number, amount: a.amount }) } }, { session });
        } else {
          await settle.apply(a.docType, a.doc, { [VOUCHER_FIELD[a.docType]]: a.amount }, session, { docNo: a.docNo });
        }
      }
      if (party) {
        await partyLedger.post({
          partyType, party: party._id, date, docType: "Payment", doc: _id, docNo: number,
          ...(kind === "receipt" ? { credit: settledTotal } : { debit: settledTotal }),
          narration: data.narration || `${kind === "receipt" ? "Received" : "Paid"} by ${b.mode}${data.reference ? ` · ${data.reference}` : ""}${adjTotal ? ` · adjusted ₹${adjTotal.toFixed(2)}` : ""}`,
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
  const v = await Payment.findById(req.params.id).lean();
  if (!v) return next(new ErrorHandler("Voucher not found", 404));
  if (v.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(v.date, req, { cancelling: true }); } catch (err) { return next(err); }
  const cancel = { reason, at: new Date(), by: req.user?._id };
  const mark = fp(ACTION_CODES.PAYMENT_CANCELLED, v, req, { voucherNo: v.voucherNo, reason });
  try {
    await withTxn(async (session) => {
      await Payment.updateOne({ _id: v._id }, { $set: { status: "cancelled", cancel }, $push: { fingerprints: mark } }, { session });
      for (const a of v.allocations) {
        if (a.docType === "SupplierBill") {
          await settle.apply("SupplierBill", a.doc, { paidAmount: -r2(a.amount - (a.tds || 0)), tdsAmount: -(a.tds || 0) }, session);
        } else if (a.docType === "Expense") {
          await settle.apply("Expense", a.doc, { paidAmount: -a.amount }, session);
          await Expense.updateOne({ _id: a.doc, status: "approved" }, { $unset: { paidFrom: 1, paidAt: 1 } }, { session });
        } else {
          await settle.apply(a.docType, a.doc, { [VOUCHER_FIELD[a.docType]]: -a.amount }, session);
        }
      }
      await partyLedger.reverse("Payment", v._id, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, payment: await Payment.findById(v._id).select("-attachments.data").lean() });
}));

// ══════════════════════════════════════════════════════════════════
//  CREDITS: ADVANCES, UNAPPLIED NOTES, OPENING ADVANCES
// ══════════════════════════════════════════════════════════════════
//  GET  /credits?partyType=&party=   what a party has on account
//  POST /credits/apply               set some of it against open documents
router.get("/credits", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (partyType !== "customer" && partyType !== "supplier") return next(new ErrorHandler("partyType must be customer or supplier", 400));
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  res.json({ success: true, credits: await credits.openFor(partyType, req.query.party) });
}));

router.post("/credits/apply", catchAsyncErrors(async (req, res, next) => {
  try {
    const out = await credits.apply(req.body || {}, req);
    res.json({ success: true, ...out });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
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
  // The first days of a month are spent finishing the last one: until the
  // 10th, the month figures are last month's.
  const back = now.getDate() < 10 ? 1 : 0;
  const monthStart = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() - back + 1, 0, 23, 59, 59, 999);
  const inMonth = { $gte: monthStart, $lte: monthEnd };
  const [recv, pay, accounts, pendingExpenses, monthExpenses, monthInvoices, monthBills, recentPayments] = await Promise.all([
    outstanding.receivables(),
    outstanding.payables(),
    BankAccount.find({ active: true }).lean(),
    Expense.countDocuments({ status: "pending" }),
    Expense.aggregate([{ $match: { status: { $in: ["approved", "paid"] }, date: inMonth } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: { status: "issued", invoiceDate: inMonth } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, tax: { $sum: "$totals.tax" }, count: { $sum: 1 } } }]),
    SupplierBill.aggregate([{ $match: { status: { $ne: "cancelled" }, billDate: inMonth } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, itc: { $sum: "$itc.amount" }, count: { $sum: 1 } } }]),
    Payment.find({ status: "posted" }).select("kind voucherNo date partyName amount mode accountName").sort({ date: -1, createdAt: -1 }).limit(8).lean(),
  ]);
  const [balances, customerCredits, supplierCredits] = await Promise.all([
    bankBalances.withBalances(accounts), credits.byParty("customer"), credits.byParty("supplier"),
  ]);
  // What a party paid ahead, or was paid ahead, sits beside what is open:
  // the documents stay open until the credit is set against them.
  const withAhead = (groups, map) => groups.map((g) => ({ ...g, paidAhead: map.get(String(g.party))?.available || 0 }));
  const aheadTotal = (rows, map) => { const parties = new Set(rows.map((x) => String(x.party))); return r2([...map.entries()].filter(([k]) => parties.has(k)).reduce((s, [, v]) => s + v.available, 0)); };
  res.json({
    success: true,
    receivables: { ...outstanding.totals(recv), paidAhead: aheadTotal(recv, customerCredits), top: withAhead(outstanding.byParty(recv).slice(0, 5), customerCredits) },
    payables: { ...outstanding.totals(pay), paidAhead: aheadTotal(pay, supplierCredits), top: withAhead(outstanding.byParty(pay).slice(0, 5), supplierCredits) },
    accounts: balances.map((a) => ({ _id: a._id, name: a.name, kind: a.kind, balance: a.balance })),
    pendingExpenses,
    month: {
      from: monthStart, to: monthEnd, current: back === 0,
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
  res.json({ success: true, ...(await gstSummary.summary({ from: r.from, to: r.to })) });
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
    const g = byDeductee.get(key) || { supplier: v.supplier, partyName: v.partyName, section: v.tds.section, rate: v.tds.rate, gross: 0, base: 0, tds: 0, vouchers: [] };
    const gross = r2(v.amount + v.tds.amount);
    // What it was deducted on: the bills' value net of GST (older vouchers: the gross).
    const base = r2(v.tds.base || gross);
    g.gross = r2(g.gross + gross); g.base = r2(g.base + base); g.tds = r2(g.tds + v.tds.amount);
    g.vouchers.push({ _id: v._id, voucherNo: v.voucherNo, date: v.date, gross, base, tds: v.tds.amount, docs: v.allocations.map((a) => a.docNo) });
    byDeductee.set(key, g);
  }
  const rows = [...byDeductee.values()];
  res.json({ success: true, from: r.from, to: r.to, rows, total: { gross: r2(rows.reduce((s, g) => s + g.gross, 0)), base: r2(rows.reduce((s, g) => s + g.base, 0)), tds: r2(rows.reduce((s, g) => s + g.tds, 0)) } });
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
  const opening = await bankBalances.balanceBefore(account, r.from);
  const [vouchers, contras] = await Promise.all([
    Payment.find({ status: "posted", account: account._id, date: { $gte: r.from, $lte: r.to } })
      .select("kind voucherNo date partyName amount mode reference narration allocations clearedOn createdAt").lean(),
    Contra.find({ status: "posted", $or: [{ from: account._id }, { to: account._id }], date: { $gte: r.from, $lte: r.to } }).lean(),
  ]);
  // A contra is a row like a voucher: in when the money came to this account.
  const moves = [
    ...vouchers.map((v) => ({ ...v, docType: "Payment", inflow: v.kind === "receipt" ? v.amount : 0, outflow: v.kind === "payment" ? v.amount : 0 })),
    ...contras.map((c) => {
      const incoming = String(c.to) === String(account._id);
      return { _id: c._id, docType: "Contra", kind: "contra", voucherNo: c.contraNo, date: c.date, createdAt: c.createdAt, partyName: incoming ? `From ${c.fromName}` : `To ${c.toName}`, amount: c.amount, mode: c.mode, reference: c.reference, narration: c.narration, allocations: [], clearedOn: incoming ? c.toClearedOn : c.fromClearedOn, inflow: incoming ? c.amount : 0, outflow: incoming ? 0 : c.amount };
    }),
  ].sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt));
  let running = opening;
  const rows = moves.map((v) => {
    running = r2(running + v.inflow - v.outflow);
    return { ...v, balance: running };
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
  // A line set aside in an earlier upload stays set aside.
  const keys = matched.map((r) => bankStatement.lineKey(r));
  const earlier = await BankStatement.find({ account: account._id, "lines.key": { $in: keys } }).select("lines.key lines.status lines.note").lean();
  const ignored = new Map();
  for (const st of earlier) for (const l of st.lines) if (l.status === "ignored" && keys.includes(l.key)) ignored.set(l.key, l.note);
  for (const [i, r] of matched.entries()) {
    if (r.status !== "recorded" && ignored.has(keys[i])) { r.status = "ignored"; r.note = ignored.get(keys[i]); r.suggestion = null; }
  }
  const dates = rows.map((r) => r.date.getTime());
  const statement = await BankStatement.create({
    account: account._id, accountName: account.name, file: req.file.originalname || "",
    from: new Date(Math.min(...dates)), to: new Date(Math.max(...dates)), closingBalance: bankStatement.closingOf(rows),
    uploadedBy: req.user?._id, uploadedByName: req.user?.name || "",
    lines: matched.map((r, i) => ({
      index: r.index, date: r.date, narration: r.narration, ref: r.ref, amount: r.amount, direction: r.direction, balance: r.balance ?? null, key: keys[i],
      status: r.status, voucherType: r.recorded?.voucherType || null, voucher: r.recorded?._id || null, voucherNo: r.recorded?.voucherNo || "", note: r.note || "",
    })),
  });
  // What the bank shows is cleared in the books.
  for (const r of matched) if (r.status === "recorded" && r.recorded) await reconcile.markCleared(r.recorded.voucherType, r.recorded._id, account._id, r.date);
  const counts = { recorded: 0, matched: 0, unmatched: 0 };
  for (const r of matched) counts[r.status] = (counts[r.status] || 0) + 1;
  res.json({ success: true, statement: statement._id, account: { _id: account._id, name: account.name }, rows: matched, counts, file: req.file.originalname, closingBalance: statement.closingBalance });
}));

router.post("/bank/statement/post", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return next(new ErrorHandler("No lines to post", 400));
  if (rows.length > 500) return next(new ErrorHandler("At most 500 lines at a time", 400));
  const statementId = isId(req.body?.statement) ? req.body.statement : null;
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
        adjustments: Array.isArray(r.adjustments) ? r.adjustments : [],
        narration: r.narration || "", source: "statement", statementLine: `${r.date || ""} ${r.narration || ""}`.trim().slice(0, 200),
        clearedOn: r.date, requestId: r.requestId,
      }, req);
      if (statementId && Number.isInteger(r.index)) {
        await BankStatement.updateOne({ _id: statementId, "lines.index": r.index }, { $set: { "lines.$.status": "posted", "lines.$.voucherType": "Payment", "lines.$.voucher": voucher._id, "lines.$.voucherNo": voucher.voucherNo } });
      }
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
router.get("/collections", catchAsyncErrors(async (req, res) => {
  const rows = await collections.overdue({ includeHeld: req.query.held === "true" });
  res.json({ success: true, rows, total: r2(rows.reduce((s, r) => s + r.overdue, 0)), whatsapp: whatsappConfigured() });
}));

router.post("/collections/draft", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.body?.customer)) return next(new ErrorHandler("customer is required", 400));
  const entry = (await collections.overdue({ includeHeld: true })).find((r) => String(r.party) === String(req.body.customer));
  if (!entry) return next(new ErrorHandler("Nothing overdue for this customer", 404));
  const settings = await getDocumentSettings();
  // The ladder picks the tone unless the person did.
  const tone = req.body?.tone === "firm" || req.body?.tone === "gentle" ? req.body.tone : entry.next.tone;
  const out = await collections.draft(entry, { company: settings.companyName || "Balu Elastics", tone });
  res.json({ success: true, ...out, tone, to: collections.e164(entry.contact.accountantPhone || entry.contact.phone), entry });
}));

router.post("/collections/send", catchAsyncErrors(async (req, res, next) => {
  const to = collections.e164(req.body?.to);
  const message = String(req.body?.message || "").trim();
  if (!to) return next(new ErrorHandler("A phone number is required", 400));
  if (message.length < 20) return next(new ErrorHandler("The message is too short to send", 400));
  const result = await sendWhatsApp(to, message.slice(0, 1500));
  // Remembered against the customer, so tomorrow's list knows.
  if (isId(req.body?.customer)) {
    await collections.log({ customer: req.body.customer, kind: "reminder", channel: "whatsapp", tone: String(req.body?.tone || ""), to, message, result: result.sent ? "sent" : result.dryRun ? "dry run" : String(result.error || "failed"), user: req.user });
  }
  res.json({ success: true, ...result, to });
}));

/** A call made, a promise to pay, or a note — by hand. */
router.post("/collections/log", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (!isId(b.customer)) return next(new ErrorHandler("customer is required", 400));
  if (!["call", "promise", "note", "reminder"].includes(b.kind)) return next(new ErrorHandler("kind must be call, promise, note or reminder", 400));
  let promiseDate = null;
  try { promiseDate = readDate(b.promiseDate, "promiseDate", null); } catch (err) { return next(err); }
  if (b.kind === "promise" && !promiseDate) return next(new ErrorHandler("When did they promise to pay?", 400));
  if (b.kind !== "promise" && String(b.note || "").trim().length < 3) return next(new ErrorHandler("Say what happened", 400));
  const note = await collections.log({ customer: b.customer, kind: b.kind, channel: String(b.channel || (b.kind === "call" ? "phone" : "")), note: b.note, promiseDate, promiseAmount: b.promiseAmount, user: req.user });
  res.status(201).json({ success: true, note });
}));

router.get("/collections/:customer/history", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.customer)) return next(new ErrorHandler("Customer not found", 404));
  res.json({ success: true, history: await collections.historyOf(req.params.customer) });
}));

// Contras, opening balances, settings and the lock.
router.use(require("./accountsBooks"));

module.exports = router;
module.exports.createVoucher = createVoucher;
