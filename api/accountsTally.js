"use strict";
// ══════════════════════════════════════════════════════════════════
//  TO TALLY  (inside /api/v2/accounts)
//
//    GET  /tally/preview?from=&to=     what would go: vouchers by type,
//                                      the ledgers Tally must have, and
//                                      anything that would not balance
//    POST /tally/export                { from, to, lock, masters } →
//                                      a batch: every document in it is
//                                      stamped and never goes twice;
//                                      "lock" closes the books to `to`
//    GET  /tally/batches               what went before
//    GET  /tally/batches/:id/xml       the file to import in Tally
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isId, readDate, DAY } = require("../services/accountsHelpers");
const { getSettings } = require("../services/booksLock");
const { getDocumentSettings } = require("../services/documentSettings");
const tally = require("../services/tallyExport");
const { nextNumber } = require("../utils/sequence");
const TallyBatch = require("../models/TallyBatch");
const AccountsSettings = require("../models/AccountsSettings");

const MODELS = {
  Invoice: () => require("../models/Invoice"),
  SupplierBill: () => require("../models/SupplierBill"),
  Expense: () => require("../models/Expense"),
  AccountNote: () => require("../models/AccountNote"),
  Payment: () => require("../models/Payment"),
  Contra: () => require("../models/Contra"),
};

function period(src) {
  const from = readDate(src.from, "from");
  let to = readDate(src.to, "to");
  if (!from || !to) throw new ErrorHandler("from and to are required", 400);
  to = new Date(new Date(to).setHours(0, 0, 0, 0) + DAY - 1);
  if (to < from) throw new ErrorHandler("to is before from", 400);
  if (to - from > 400 * DAY) throw new ErrorHandler("Export at most a year at a time", 400);
  return { from, to };
}

/** The ledger names, with the schema's defaults under anything left blank. */
async function ledgerNames() {
  const s = await getSettings();
  const defaults = new AccountsSettings().toObject().tally;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(s.tally || {})) if (String(v || "").trim()) out[k] = v;
  return out;
}

router.get("/tally/preview", catchAsyncErrors(async (req, res, next) => {
  let p;
  try { p = period(req.query); } catch (err) { return next(err); }
  const L = await ledgerNames();
  const [fresh, all] = await Promise.all([tally.build({ ...p, fresh: true, L }), tally.build({ ...p, fresh: false, L })]);
  res.json({
    success: true, from: p.from, to: p.to,
    counts: tally.countOf(fresh.vouchers), vouchers: fresh.vouchers.length,
    alreadySent: all.vouchers.length - fresh.vouchers.length,
    ledgers: tally.ledgersOf(fresh.vouchers), problems: fresh.problems,
    sample: fresh.vouchers.slice(0, 20).map((v) => ({ type: v.type, number: v.number, date: v.date, party: v.party, lines: v.lines.map((l) => ({ ledger: l.ledger, debit: l.amount > 0 ? l.amount : 0, credit: l.amount < 0 ? -l.amount : 0 })) })),
  });
}));

router.post("/tally/export", catchAsyncErrors(async (req, res, next) => {
  let p;
  try { p = period(req.body || {}); } catch (err) { return next(err); }
  const lock = !!req.body?.lock;
  if (lock && req.user?.role !== "admin") return next(new ErrorHandler("Only an admin can lock the books", 403));
  const L = await ledgerNames();
  const { vouchers, problems } = await tally.build({ ...p, fresh: true, L });
  if (problems.length) return next(new ErrorHandler(`Some vouchers would not balance: ${problems.slice(0, 3).join("; ")}`, 409));
  if (!vouchers.length) return next(new ErrorHandler("Nothing new to send for this period", 409));
  const company = L.companyName || (await getDocumentSettings()).companyName || "";
  const masters = req.body?.masters ? { ...tally.partiesOf(vouchers), debtorsGroup: L.debtorsGroup || "Sundry Debtors", creditorsGroup: L.creditorsGroup || "Sundry Creditors" } : null;
  const xml = tally.toXml(vouchers, { company, masters });
  const batchNo = await nextNumber("tally-batch", async () => (await TallyBatch.findOne({}).sort({ batchNo: -1 }).select("batchNo").lean())?.batchNo ?? 0);
  const batch = await TallyBatch.create({
    batchNo, from: p.from, to: p.to, counts: tally.countOf(vouchers), vouchers: vouchers.length,
    docs: vouchers.map((v) => ({ docType: v.docType, doc: v.doc, number: v.number })), ledgers: tally.ledgersOf(vouchers),
    lockedUpTo: lock ? p.to : null, by: req.user?._id, byName: req.user?.name || "", xml,
  });
  // Stamp what went, so it never goes twice.
  const stamp = { tally: { batch: batch._id, at: new Date() } };
  const byType = {};
  for (const v of vouchers) (byType[v.docType] = byType[v.docType] || []).push(v.doc);
  for (const [type, ids] of Object.entries(byType)) await MODELS[type]().updateMany({ _id: { $in: ids } }, { $set: stamp });
  if (lock) {
    const current = (await getSettings()).lockDate;
    if (!current || new Date(current) < p.to) {
      await AccountsSettings.updateOne({ key: "accounts" }, { $set: { lockDate: new Date(new Date(p.to).setHours(0, 0, 0, 0)), lockedBy: req.user?.name || "", lockedAt: new Date() } });
    }
  }
  const out = batch.toObject();
  delete out.xml;
  res.status(201).json({ success: true, batch: out });
}));

router.get("/tally/batches", catchAsyncErrors(async (_req, res) => {
  const batches = await TallyBatch.find({}).select("-docs").sort({ batchNo: -1 }).limit(50).lean();
  res.json({ success: true, batches });
}));

router.get("/tally/batches/:id/xml", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Batch not found", 404));
  const b = await TallyBatch.findById(req.params.id).select("+xml batchNo from").lean();
  if (!b) return next(new ErrorHandler("Batch not found", 404));
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="tally-batch-${b.batchNo}.xml"`);
  res.send(b.xml);
}));

module.exports = router;
