"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — MASTERS, SUPPLIER BILLS, ATTACHMENTS  (part of /api/v2/accounts)
//
//  Bank accounts and expense categories, the bills suppliers send,
//  and the files attached to a bill, expense, note or voucher.
//
//    GET   /bank-accounts
//    POST  /bank-accounts
//    PUT   /bank-accounts/:id
//    GET   /categories
//    POST  /categories
//    PUT   /categories/:id
//    GET   /bills/po-info
//    GET   /bills
//    GET   /bills/:id
//    POST  /bills
//    POST  /bills/:id/cancel
//    POST  /:kind(bills|expenses|notes|payments)/:id/attachments
//    GET   /:kind(bills|expenses|notes|payments)/:id/attachments/:aid
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const { noted } = require("../utils/noted");
const mongoose = require("mongoose");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAdmin }      = require("../middleware/auth");
const { keepRequestContext } = require("../middleware/userContext");
const { sendStoredFile } = require("../utils/sendFile");
const { escapeRegex }  = require("../utils/escapeRegex");
const { ACTION_CODES } = require("../utils/fingerprint");
const { stateCodeFromGstin } = require("../services/gst");
const { getDocumentSettings } = require("../services/documentSettings");
const { allocate } = require("../services/docNumbers");
const partyLedger  = require("../services/partyLedger");
const { ensureSeed } = require("../services/accountsSeed");
const msmeService = require("../services/msme");
const tdsService = require("../services/tds");
const MachineServiceBill = require("../models/MachineServiceBill");
const costCentres   = require("../services/costCentres");
const aiLedger      = require("../services/aiLedger");
const BankAccount     = require("../models/BankAccount");
const ExpenseCategory = require("../models/ExpenseCategory");
const SupplierBill    = require("../models/SupplierBill");
const Expense         = require("../models/Expense");
const AccountNote     = require("../models/AccountNote");
const Payment         = require("../models/Payment");
const Supplier        = require("../models/Supplier");
const PurchaseOrder   = require("../models/PurchaseOrder");
const MaterialInward  = require("../models/MaterialInward");
const {
  DAY,
  isId,
  r2,
  readDate,
  reasonFrom,
  fp,
  withTxn,
  paging,
} = require("../services/accountsHelpers");
const billChecks = require("../services/billChecks");
const attachments = require("../services/attachments");
const { getSettings: getBooksSettings } = require("../services/booksLock");
const bankBalances = require("../services/bankBalances");
const { assertOpen } = require("../services/booksLock");
const { onceAtATime } = require("../utils/onceAtATime");
const { replayOf, replayAfter } = require("../services/posting");
const { upload, sellerStateCode, readLines, priced } = require("./accountsCommon");
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  MASTERS
// ══════════════════════════════════════════════════════════════════
router.get("/bank-accounts", catchAsyncErrors(async (_req, res) => {
  await ensureSeed();
  const accounts = await BankAccount.find({}).sort({ isDefault: -1, name: 1 }).lean();
  // The book balance per account: opening + money in − money out, contras both ways.
  res.json({ success: true, accounts: await bankBalances.withBalances(accounts) });
}));

const ACCOUNT_FIELDS = ["name", "kind", "bankName", "accountNo", "ifsc", "upiId", "openingBalance", "openingDate", "float", "active", "isDefault", "tallyLedger", "statementFrom"];
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
  const before = await replayOf(SupplierBill, b.requestId, { select: "-attachments.data" });
  if (before) return res.status(200).json({ success: true, bill: before, replay: true });
  const supplier = await Supplier.findById(b.supplier).lean();
  if (!supplier) return next(new ErrorHandler("Supplier not found", 404));
  let billDate, dueDate, lines;
  try {
    billDate = readDate(b.billDate, "billDate", new Date());
    await assertOpen(billDate, req);
    dueDate = readDate(b.dueDate, "dueDate", new Date(billDate.getTime() + (supplier.paymentTermsDays ?? 30) * DAY));
    // A micro or small enterprise must be paid within its statutory days (MSMED Act s.15), whatever the terms say.
    if (msmeService.isMsme(supplier)) {
      const statutory = new Date(billDate.getTime() + msmeService.statutoryDays(supplier) * DAY);
      if (dueDate > statutory) dueDate = statutory;
    }
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
  // One bill at a time for a supplier. Whether a goods receipt is already
  // on a bill is looked up and then the bill is entered: two requests
  // together both found the receipt free and both billed it. The second
  // now waits for the first and is told the receipt is taken.
  await onceAtATime(`bill:supplier:${supplier._id}`, async () => {
  // What went wrong after the bill was safely in the books, to tell the person.
  const warnings = [];
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
  // s.194Q: once this year's goods purchases from the supplier pass the limit, TDS on the rest.
  let q194 = null;
  if (!tds.applicable && b.kind !== "service") {
    q194 = await tdsService.apply194q(supplier._id, billDate, gst.totals.taxable);
    if (q194) { tds.applicable = true; tds.section = "194Q"; tds.rate = q194.rate; }
  }
  // Entered from a machine's service log: the file comes along, and both sides link.
  let serviceBill = null;
  if (isId(b.serviceBill)) {
    serviceBill = await MachineServiceBill.findById(b.serviceBill).lean();
    if (!serviceBill) return next(new ErrorHandler("Service bill not found", 404));
    if (serviceBill.supplierBill) return next(new ErrorHandler("That service bill is already entered in the books", 409));
  }

  // Opened from the bills mailbox: the item must still be waiting.
  let inboxBill = null;
  if (isId(b.inboxBill)) {
    inboxBill = await require("../models/InboxBill").findOne({ _id: b.inboxBill, part: { $gt: 0 } }).select("+data status contentType filename size").lean();
    if (!inboxBill) return next(new ErrorHandler("That bill from the mailbox is not found", 404));
    if (inboxBill.status === "entered") return next(new ErrorHandler("That bill from the mailbox is entered already", 409));
  }

  let costCentre;
  try { costCentre = await costCentres.read(b.costCentre); } catch (err) { return next(err); }

  const { financialYear, sequence, number } = await allocate(SupplierBill, "PB", { at: billDate });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, billNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined,
    supplier: supplier._id, supplierName: supplier.name, supplierGstin: String(supplier.gstin || "").toUpperCase(), supplierStateCode: supplierState,
    supplierBillNo: supplierBillNo.slice(0, 40), billDate, dueDate,
    purchaseOrder: po?._id, poNo: po?.poNo, inwards: inwardIds,
    kind: b.kind === "service" ? "service" : "goods", category: isId(b.category) ? b.category : undefined,
    ...(serviceBill ? { machine: serviceBill.machine, serviceBill: serviceBill._id } : {}),
    ...(costCentre ? { costCentre } : {}),
    supplyType: p.supplyType, lines: p.lines, totals: gst.totals,
    reverseCharge, ...(gst.rcm ? { rcm: gst.rcm } : {}),
    itc: { eligible: itcEligible, amount: gst.itcAmount },
    ...(variance.lines.length ? { variance: { ...variance, note: varianceNote.slice(0, 300) } } : {}),
    tds, notes: String(b.notes || "").trim().slice(0, 500), source: b.source === "scan" ? "scan" : "manual",
    aiSuggestion: isId(b.aiSuggestion) ? b.aiSuggestion : undefined, createdBy: req.user?._id,
    fingerprints: [fp(ACTION_CODES.BILL_CREATED, { _id }, req, { billNo: number, supplierBillNo, supplier: supplier.name, grand: gst.totals.grand, ...(variance.lines.length ? { variance: variance.total, note: varianceNote } : {}), ...(reverseCharge ? { reverseCharge: true } : {}), ...(q194 ? { tds194q: q194 } : {}), ...(serviceBill ? { serviceBill: serviceBill._id } : {}) })],
  };
  let doc;
  try {
    await withTxn(async (session) => {
      [doc] = await SupplierBill.create([data], { session });
      await partyLedger.post({ partyType: "supplier", party: supplier._id, date: billDate, docType: "SupplierBill", doc: _id, docNo: number, credit: gst.totals.grand, narration: `Bill ${supplierBillNo}${po ? ` · PO #${po.poNo}` : ""}${reverseCharge ? " · reverse charge" : ""}` }, session);
      // The service bill and the mailbox item are taken by writes that
      // are refused once somebody else has them: a second bill for the
      // same source is not entered at all (the result of this write used
      // to go unread, and the mailbox item was marked after the fact).
      if (serviceBill) {
        const r = await MachineServiceBill.updateOne({ _id: serviceBill._id, supplierBill: null }, { $set: { supplierBill: _id } }, { session });
        if (!r.modifiedCount) throw new ErrorHandler("That service bill is already entered in the books", 409);
      }
      if (inboxBill) {
        const r = await require("../models/InboxBill").updateOne({ _id: inboxBill._id, status: { $ne: "entered" } }, { $set: { status: "entered", bill: _id, note: number, decidedBy: req.user?._id, decidedAt: new Date() } }, { session });
        if (!r.modifiedCount) throw new ErrorHandler("That bill from the mailbox is entered already", 409);
      }
    });
    if (inboxBill) {
      // The mailbox item's file goes with the bill.
      if (inboxBill.data) {
        const base64 = String(inboxBill.data).split(",")[1] || "";
        await attachments.attach(SupplierBill, "bills", _id, { buffer: Buffer.from(base64, "base64"), mimetype: inboxBill.contentType, originalname: inboxBill.filename || "bill", size: inboxBill.size })
          .catch(noted(`attaching the mailed bill's file to ${number}`, warnings, "The bill is entered, but the file that came by mail could not be attached to it — attach it by hand."));
      }
    }
    if (serviceBill?.data) {
      // The photo or PDF from the service log becomes the bill's attachment.
      const base64 = String(serviceBill.data).split(",")[1] || "";
      await attachments.attach(SupplierBill, "bills", _id, { buffer: Buffer.from(base64, "base64"), mimetype: serviceBill.contentType, originalname: serviceBill.filename || "service-bill", size: serviceBill.size })
        .catch(noted(`attaching the service bill's photo to ${number}`, warnings, "The bill is entered, but the photo from the service log could not be attached to it — attach it by hand."));
    }
  } catch (err) {
    if (err?.code === 11000) {
      const dup = await replayAfter(err, SupplierBill, b.requestId, { select: "-attachments.data" });
      if (dup) return res.status(200).json({ success: true, bill: dup, replay: true });
      return next(new ErrorHandler(`Bill ${supplierBillNo} from ${supplier.name} is already entered`, 409));
    }
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  // What the person kept of the scan: the AI's accuracy, field by field.
  if (data.aiSuggestion) {
    aiLedger.settle(data.aiSuggestion, {
      accepted: { supplierGstin: data.supplierGstin, billNo: data.supplierBillNo, billDate: billDate.toISOString().slice(0, 10), lines: data.lines.map((l) => ({ description: l.description, hsn: l.hsn, quantity: l.quantity, unit: l.unit, rate: l.rate, gstPercent: l.gstPercent })), totals: { taxable: data.totals.taxable, grand: data.totals.grand } },
      decidedBy: req.user?._id, expectSurface: "bill-ocr", ignoreMissing: true,
    }).catch(noted(`scoring the bill scan against ${number}`));
    await require("../services/billImages").link(data.aiSuggestion, { docType: "SupplierBill", docId: doc._id, docNo: doc.billNo, partyName: doc.supplierName, amount: doc.totals?.grand, date: doc.billDate });
  }
  res.status(201).json({ success: true, bill: doc.toObject(), ...(warnings.length ? { warnings } : {}) });
  }, { what: "A bill from this supplier" });
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
  try {
    await withTxn(async (session) => {
      // Conditional on nothing having been set against it meanwhile: a
      // payment landing between the check above and this write would
      // otherwise settle a bill that no longer exists.
      const r = await SupplierBill.updateOne(
        { _id: bill._id, status: { $ne: "cancelled" }, paidAmount: { $lte: 0 }, tdsAmount: { $lte: 0 }, debitedAmount: { $lte: 0 } },
        { $set: { status: "cancelled", cancel }, $push: { fingerprints: mark } }, { session }
      );
      if (r.matchedCount === 0) throw new ErrorHandler("Something was set against this bill meanwhile — cancel that first.", 409);
      await partyLedger.reverse("SupplierBill", bill._id, session);
      // What the bill was entered from is free to be entered again: the
      // machine's service bill goes back on the "not yet in the books"
      // list, and the mailbox item back among the new ones. (Neither was
      // told before, so a bill cancelled to be corrected could never be
      // entered a second time.)
      await MachineServiceBill.updateMany({ supplierBill: bill._id }, { $set: { supplierBill: null } }, { session });
      await require("../models/InboxBill").updateMany(
        { bill: bill._id, status: "entered" },
        { $set: { status: "new", bill: null, decidedBy: null, decidedAt: null, note: `${bill.billNo} was cancelled: to be entered again` } },
        { session }
      );
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
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
  sendStoredFile(res, { ...f, fallbackName: "attachment" });
}));

module.exports = router;
