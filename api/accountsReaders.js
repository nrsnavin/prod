"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — WHAT COMES IN TO BE READ  (part of /api/v2/accounts)
//
//  A bill photographed, a customer's payment advice, a supplier's
//  statement, the customer and bill mailboxes, a bank statement.
//
//    POST  /scan
//    POST  /advice/read
//    POST  /supplier-recon
//    GET   /customer-mail/status
//    POST  /customer-mail/run
//    GET   /customer-mail
//    GET   /customer-mail/:id
//    POST  /customer-mail/:id/:action(dismiss|done)
//    GET   /bill-inbox/status
//    POST  /bill-inbox/run
//    GET   /bill-inbox
//    GET   /bill-inbox/:id
//    GET   /bill-inbox/:id/file
//    POST  /bill-inbox/:id/dismiss
//    POST  /bank/statement
//    POST  /bank/statement/post
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const mongoose = require("mongoose");
const multer   = require("multer");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { sendStoredFile } = require("../utils/sendFile");
const { ACTION_CODES } = require("../utils/fingerprint");
const { allocate } = require("../services/docNumbers");
const { readBill }  = require("../utils/billOcr");
const { importStatement } = require("../services/statementImport");
const aiLedger      = require("../services/aiLedger");
const { promptVersion } = require("../utils/aiPrompts");
const BankAccount     = require("../models/BankAccount");
const Contra          = require("../models/Contra");
const BankStatement   = require("../models/BankStatement");
const BankAlias       = require("../models/BankAlias");
const { isId, r2, readDate, fp } = require("../services/accountsHelpers");
const { assertOpen } = require("../services/booksLock");
// ══════════════════════════════════════════════════════════════════
//  BILLS THAT CAME BY MAIL (services/billMailbox.js)
// ══════════════════════════════════════════════════════════════════
//  GET  /bill-inbox?status=new   the mailbox's bills, read and matched
//  GET  /bill-inbox/status        is the mailbox set up
//  POST /bill-inbox/run           read the mailbox now
//  GET  /bill-inbox/:id           one, as a scan returns it, to open as a bill
//  GET  /bill-inbox/:id/file      the PDF or photo
//  POST /bill-inbox/:id/dismiss   { reason } — not a bill for the books
//  Entering it is POST /bills with { inboxBill: id }: the item is marked
//  entered and the file goes with the bill.
const InboxBill = require("../models/InboxBill");
const billMailbox = require("../services/billMailbox");
// ── Customer mail (services/customerInbox.js) ─────────────────────
const InboxMail = require("../models/InboxMail");
const { upload, createVoucher } = require("./accountsCommon");
const router = express.Router();

const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4 } });
// A supplier's statement can run to six pages.
const statementPagesUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 } });

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
  // The same photo already on a saved bill or expense (sent twice on WhatsApp, forwarded again).
  const pages = files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype }));
  const billImages = require("../services/billImages");
  const samePhoto = await billImages.check(pages).catch(() => []);
  await billImages.remember(pages, suggestionId);
  if (read.problem) {
    return res.json({ success: true, read, supplier: null, purchaseOrders: [], samePhoto, aiSuggestion: suggestionId });
  }
  // Who it is on file, whether it is entered already, and what is still to bill (services/billMatch.js).
  const match = await require("../services/billMatch").matchRead(read);
  res.json({ success: true, read, supplier: match.supplier, alreadyEntered: match.alreadyEntered, purchaseOrders: match.purchaseOrders, samePhoto, aiSuggestion: suggestionId });
}));

// ══════════════════════════════════════════════════════════════════
//  AI: A CUSTOMER'S PAYMENT ADVICE INTO A RECEIPT
// ══════════════════════════════════════════════════════════════════
//  POST /advice/read  multipart "files" (PDF / photos) or { text }, and
//  optionally { customer } → what it says, placed on the books: the
//  customer, each invoice settled gross, TDS and discount as the
//  receipt's adjustments, what did not match, and the bank line it came
//  in on. Nothing is saved: the receipt form opens filled in.
router.post("/advice/read", keepRequestContext(scanUpload.array("files", 4)), catchAsyncErrors(async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  const text = String(req.body?.text || "");
  let read;
  const startedAt = Date.now();
  try {
    read = await require("../utils/adviceOcr").readAdvice({ pages: files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })), text });
  } catch (err) {
    if (err.code === "ANTHROPIC_KEY_MISSING") return next(new ErrorHandler("Reading advices is not configured on this server (no AI key).", 503));
    if (err.code) return next(new ErrorHandler(err.message, 400));
    await aiLedger.record({ surface: "payment-advice", model: "?", promptVersion: promptVersion("payment-advice"), latencyMs: Date.now() - startedAt, error: err.message });
    return next(new ErrorHandler(`The advice could not be read: ${err.message}`, 502));
  }
  const placed = read.problem ? null : await require("../services/adviceMatch").placeAdvice(read, { customer: isId(req.body?.customer) ? req.body.customer : null });
  // Scored on what can be compared with the receipt entered: the invoices
  // as they are on file, not as the advice wrote them short.
  const suggestionId = await aiLedger.record({
    surface: "payment-advice", model: read.model, promptVersion: promptVersion("payment-advice"),
    proposed: {
      amount: read.amount, date: read.date, reference: read.reference,
      invoices: placed ? placed.allocations.filter((a) => a.docType === "Invoice").map((a) => a.docNo) : read.lines.map((l) => l.invoiceNo),
      tds: placed ? (placed.adjustments.find((a) => a.kind === "tds_by_customer")?.amount || 0) : (read.tdsTotal || 0),
    },
    latencyMs: read.latencyMs, usage: read.usage,
  });
  res.json({ success: true, read, placed, aiSuggestion: suggestionId });
}));

// ══════════════════════════════════════════════════════════════════
//  AI: A SUPPLIER'S STATEMENT AGAINST OUR BOOKS
// ══════════════════════════════════════════════════════════════════
//  POST /supplier-recon  multipart "files" (PDF / photos / one Excel or
//  CSV) + supplier → their entries read and set beside our ledger of
//  them: what matches, what only they have, what only we have, and how
//  much of the balance difference that explains. Nothing is saved.
router.post("/supplier-recon", keepRequestContext(statementPagesUpload.array("files", 6)), catchAsyncErrors(async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!isId(req.body?.supplier)) return next(new ErrorHandler("Choose the supplier", 400));
  if (!files.length) return next(new ErrorHandler("Attach their statement — PDF, photo, Excel or CSV", 400));
  let read;
  const startedAt = Date.now();
  try {
    read = await require("../utils/partyStatementOcr").readStatement({ files: files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype, originalname: f.originalname })) });
  } catch (err) {
    if (err.code === "ANTHROPIC_KEY_MISSING") return next(new ErrorHandler("Reading statements is not configured on this server (no AI key).", 503));
    if (err.code) return next(new ErrorHandler(err.message, 400));
    await aiLedger.record({ surface: "supplier-statement", model: "?", promptVersion: promptVersion("supplier-statement"), latencyMs: Date.now() - startedAt, error: err.message });
    return next(new ErrorHandler(`The statement could not be read: ${err.message}`, 502));
  }
  await aiLedger.record({
    surface: "supplier-statement", model: read.model, promptVersion: promptVersion("supplier-statement"), refType: "supplier", refId: req.body.supplier,
    proposed: { entries: read.entries.length, opening: read.opening, closing: read.closing, from: read.from, to: read.to },
    latencyMs: read.latencyMs, usage: read.usage,
  });
  if (read.problem) return res.json({ success: true, read, recon: null });
  try {
    res.json({ success: true, read, recon: await require("../services/supplierRecon").reconcile(req.body.supplier, read) });
  } catch (err) {
    if (err.status) return next(new ErrorHandler(err.message, err.status));
    throw err;
  }
}));
const inboxRow = (x) => ({
  _id: x._id, status: x.status, note: x.note, from: x.from, subject: x.subject, receivedAt: x.receivedAt, filename: x.filename, contentType: x.contentType,
  supplier: x.supplier, supplierName: x.supplierName, matchedBy: x.matchedBy, senderKnown: !!x.senderKnown, alreadyEntered: x.alreadyEntered, grand: x.grand,
  billNo: x.read?.billNo || "", billDate: x.read?.billDate || null, confidence: x.read?.confidence ?? null, kind: x.read?.kind || null, bill: x.bill, decidedAt: x.decidedAt,
});
router.get("/customer-mail/status", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, ...require("../services/customerInbox").status() });
}));
router.post("/customer-mail/run", catchAsyncErrors(async (_req, res, next) => {
  const inbox = require("../services/customerInbox");
  if (!inbox.configured()) return next(new ErrorHandler("The customer mailbox is not set up (CUSTOMER_IMAP_*)", 400));
  res.json({ success: true, ...(await inbox.run()) });
}));
router.get("/customer-mail", catchAsyncErrors(async (req, res) => {
  const status = ["new", "done", "dismissed", "skipped"].includes(req.query.status) ? req.query.status : { $in: ["new", "done"] };
  const rows = await InboxMail.find({ status }).select("-text -draft").sort({ receivedAt: -1 }).limit(200).lean();
  res.json({ success: true, rows });
}));
router.get("/customer-mail/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const x = await InboxMail.findById(req.params.id).lean();
  if (!x) return next(new ErrorHandler("Not found", 404));
  res.json({ success: true, mail: x });
}));
router.post("/customer-mail/:id/:action(dismiss|done)", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const x = await InboxMail.findOneAndUpdate({ _id: req.params.id, status: { $in: ["new", "done", "skipped"] } },
    { $set: { status: req.params.action === "dismiss" ? "dismissed" : "done", decidedBy: req.user?._id, decidedAt: new Date() } }, { new: true }).select("-text -draft").lean();
  if (!x) return next(new ErrorHandler("Not found", 404));
  res.json({ success: true, mail: x });
}));

router.get("/bill-inbox/status", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, ...billMailbox.status(), waiting: await InboxBill.countDocuments({ status: "new" }) });
}));
router.post("/bill-inbox/run", catchAsyncErrors(async (_req, res, next) => {
  if (!billMailbox.configured()) return next(new ErrorHandler("The bills mailbox is not set up on this server (BILLS_IMAP_*).", 400));
  res.json({ success: true, ...(await billMailbox.run()) });
}));
router.get("/bill-inbox", catchAsyncErrors(async (req, res) => {
  const status = ["new", "entered", "dismissed", "failed", "skipped"].includes(req.query.status) ? req.query.status : "new";
  // Part 0 is the mail itself (its claim); the bills are its files.
  const rows = await InboxBill.find({ status, part: { $gt: 0 } }).sort({ receivedAt: -1 }).limit(200).lean();
  res.json({ success: true, bills: rows.map(inboxRow) });
}));
router.get("/bill-inbox/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const x = await InboxBill.findOne({ _id: req.params.id, part: { $gt: 0 } }).lean();
  if (!x || !x.read) return next(new ErrorHandler("Not found", 404));
  // Matched again now: a supplier added or a bill entered since it came in counts.
  const match = await require("../services/billMatch").matchRead(x.read);
  res.json({ success: true, item: inboxRow(x), read: x.read, supplier: match.supplier, alreadyEntered: match.alreadyEntered, purchaseOrders: match.purchaseOrders, aiSuggestion: x.aiSuggestion ? String(x.aiSuggestion) : null });
}));
router.get("/bill-inbox/:id/file", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const x = await InboxBill.findOne({ _id: req.params.id, part: { $gt: 0 } }).select("+data contentType filename").lean();
  if (!x?.data) return next(new ErrorHandler("Not found", 404));
  const buffer = Buffer.from(String(x.data).split(",", 2)[1] || "", "base64");
  sendStoredFile(res, { buffer, contentType: x.contentType, filename: x.filename, fallbackName: "bill", maxAge: 3600 });
}));
router.post("/bill-inbox/:id/dismiss", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  const x = await InboxBill.findOneAndUpdate({ _id: req.params.id, part: { $gt: 0 }, status: { $in: ["new", "failed", "skipped"] } },
    { $set: { status: "dismissed", note: reason || "Dismissed", decidedBy: req.user?._id, decidedAt: new Date() } }, { new: true }).lean();
  if (!x) return next(new ErrorHandler("Not found, or entered already", 404));
  // Not settled: "not ours" says nothing about whether it was read right.
  res.json({ success: true, bill: inboxRow(x) });
}));

// ══════════════════════════════════════════════════════════════════
//  AI: A BANK STATEMENT MATCHED TO THE BOOKS
// ══════════════════════════════════════════════════════════════════
//  POST /bank/statement       multipart "file" (CSV / Excel) + account
//  POST /bank/statement/post  the lines the person confirmed → vouchers
router.post("/bank/statement", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  if (!req.file) return next(new ErrorHandler("Attach the statement as CSV, Excel or MT940", 400));
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  const account = await BankAccount.findById(req.body.account).lean();
  if (!account) return next(new ErrorHandler("Account not found", 404));
  let out;
  try {
    out = await importStatement({ account, buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname, by: req.user?._id, byName: req.user?.name || "", useModel: req.body?.useModel !== "false" });
  } catch (err) {
    return next(new ErrorHandler(err.message, 400));
  }
  res.json({ success: true, statement: out.statement._id, account: { _id: account._id, name: account.name }, rows: out.rows, counts: out.counts, file: req.file.originalname, closingBalance: out.closingBalance, continuity: out.continuity });
}));

/**
 * A statement line that is money between this account and another of
 * ours, posted as a contra: out of this account to the other, or into
 * it from the other, on the line's day, and cleared here that day.
 * A replayed requestId returns the contra it made before.
 */
async function contraFromLine(r, accountId, req) {
  if (r.requestId) {
    const dup = await Contra.findOne({ requestId: String(r.requestId) }).lean();
    if (dup) return { contra: dup, replay: true };
  }
  const otherId = r.contra?.account ?? r.contra;
  if (!isId(otherId)) throw new ErrorHandler("contra.account is required", 400);
  if (String(otherId) === String(accountId)) throw new ErrorHandler("A transfer needs another account", 400);
  const [here, other] = await Promise.all([BankAccount.findById(accountId).lean(), BankAccount.findById(otherId).lean()]);
  if (!here || here.active === false || !other || other.active === false) throw new ErrorHandler("Account not found", 404);
  const amount = r2(r.amount);
  if (!(amount > 0)) throw new ErrorHandler("amount must be more than 0", 400);
  const date = readDate(r.date, "date", new Date());
  await assertOpen(date, req);
  const out = r.direction !== "in";
  const [from, to] = out ? [here, other] : [other, here];
  const { financialYear, sequence, number } = await allocate(Contra, "CTR", { at: date });
  const _id = new mongoose.Types.ObjectId();
  try {
    await Contra.create({
      _id, contraNo: number, financialYear, sequence, requestId: r.requestId ? String(r.requestId) : undefined, date,
      from: from._id, fromName: from.name, to: to._id, toName: to.name, amount,
      mode: from.kind === "cash" || to.kind === "cash" ? "cash" : "bank",
      reference: String(r.ref || "").trim().slice(0, 60), narration: String(r.narration || "").trim().slice(0, 300),
      ...(out ? { fromClearedOn: date } : { toClearedOn: date }),
      createdBy: req.user?._id,
      fingerprints: [fp(ACTION_CODES.CONTRA_POSTED, { _id }, req, { contraNo: number, from: from.name, to: to.name, amount, source: "statement" })],
    });
  } catch (err) {
    if (err?.code === 11000 && r.requestId) {
      const dup = await Contra.findOne({ requestId: String(r.requestId) }).lean();
      if (dup) return { contra: dup, replay: true };
    }
    throw err;
  }
  return { contra: await Contra.findById(_id).lean(), replay: false };
}

/**
 * Keep a payer or payee for the next statement: the text must be in the
 * line's own narration (so nothing else can be planted), and a later
 * correction of the same text replaces the party. Never throws: the
 * voucher is posted either way.
 */
async function rememberPayer(r, partyType, voucher, req) {
  try {
    const text = String(r.remember?.text ?? r.remember ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    const narration = String(r.narration || "").toUpperCase().replace(/\s+/g, " ");
    if (text.length < 4 || text.length > 80 || !narration.includes(text)) return false;
    const direction = r.direction === "in" ? "in" : "out";
    const party = partyType === "other" ? null : (partyType === "customer" ? voucher.customer : voucher.supplier) || null;
    if (partyType !== "other" && !party) return false;
    const partyName = String(voucher.partyName || r.partyName || "").trim().slice(0, 120);
    if (!partyName) return false;
    await BankAlias.updateOne(
      { text, direction },
      { $set: { partyType, party, partyName, head: voucher.head || null, headName: voucher.headName || "", incomeLedger: voucher.incomeLedger || "", createdBy: req.user?._id, createdByName: req.user?.name || "" }, $setOnInsert: { text, direction } },
      { upsert: true }
    );
    return true;
  } catch {
    return false;
  }
}

router.post("/bank/statement/post", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return next(new ErrorHandler("No lines to post", 400));
  if (rows.length > 500) return next(new ErrorHandler("At most 500 lines at a time", 400));
  // The statement the lines came from, when it is this account's: a line
  // of one account's statement is never marked posted off another's.
  let statementId = null;
  if (isId(req.body?.statement)) {
    const st = await BankStatement.findById(req.body.statement).select("account").lean();
    if (!st) return next(new ErrorHandler("Statement not found", 404));
    if (String(st.account) !== String(req.body.account)) return next(new ErrorHandler("That statement is on another account", 400));
    statementId = st._id;
  }
  const results = [];
  for (const [i, r] of rows.entries()) {
    try {
      // Money between our own accounts: a contra, not a receipt or payment.
      if (r.contra) {
        const c = await contraFromLine(r, req.body.account, req);
        if (statementId && Number.isInteger(r.index)) {
          await BankStatement.updateOne({ _id: statementId, "lines.index": r.index }, { $set: { "lines.$.status": "posted", "lines.$.voucherType": "Contra", "lines.$.voucher": c.contra._id, "lines.$.voucherNo": c.contra.contraNo } });
        }
        results.push({ index: i, ok: true, voucherNo: c.contra.contraNo, _id: c.contra._id, contra: true, replay: c.replay });
        continue;
      }
      const kind = r.direction === "in" ? "receipt" : "payment";
      const partyType = r.partyType === "customer" || r.partyType === "supplier" ? r.partyType : "other";
      const { voucher, replay } = await createVoucher({
        ...(partyType === "other" ? { head: r.head || undefined, incomeLedger: r.incomeLedger || undefined } : {}),
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
      // "Remember": the next statement's lines carrying this text are this party.
      const remembered = r.remember ? await rememberPayer(r, partyType, voucher, req) : false;
      results.push({ index: i, ok: true, voucherNo: voucher.voucherNo, _id: voucher._id, replay: !!replay, ...(r.remember ? { remembered } : {}) });
    } catch (err) {
      results.push({ index: i, ok: false, error: err.message });
    }
  }
  res.json({ success: true, results, posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
}));

module.exports = router;
