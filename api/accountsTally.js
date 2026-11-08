"use strict";
// ══════════════════════════════════════════════════════════════════
//  TO TALLY  (inside /api/v2/accounts)
//
//    GET  /tally/preview?from=&to=     what would go: vouchers by type,
//                                      cancellations, credits applied,
//                                      the ledgers Tally must have, and
//                                      anything that would not balance
//    POST /tally/export                { from, to, lock, masters, via } →
//                                      a batch, stamped in one transaction:
//                                      a document goes once, even when two
//                                      people export at the same moment.
//                                      via "connector" queues it for the
//                                      program on the Tally computer;
//                                      "file" (default) is a download
//    GET  /tally/batches               what went before, and how it landed
//    GET  /tally/batches/:id/xml       the file to import in Tally
//    POST /tally/batches/:id/requeue   offer a stuck batch to the connector again
//
//    GET  /tally/connector             is the connector set up, and alive
//    POST /tally/connector/key         a new key (admin; shown once)
//    DELETE /tally/connector/key       cut the connector off (admin)
//    GET  /tally/connector/script      the connector program
//
//    GET  /tally/reconcile             Tally's last reading against these
//                                      books: party and bank balances,
//                                      ledgers missing in Tally
// ══════════════════════════════════════════════════════════════════

const factoryDay = require("../utils/factoryDay");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAdmin } = require("../middleware/auth");
const { isId, readDate, DAY, r2, withTxn } = require("../services/accountsHelpers");
const { getSettings } = require("../services/booksLock");
const { getDocumentSettings } = require("../services/documentSettings");
const tally = require("../services/tallyExport");
const { envelope, MODELS } = require("../services/tallyQueue");
const { nextNumber } = require("../utils/sequence");
const TallyBatch = require("../models/TallyBatch");
const TallySnapshot = require("../models/TallySnapshot");
const AccountsSettings = require("../models/AccountsSettings");

function period(src) {
  const from = readDate(src.from, "from");
  let to = readDate(src.to, "to");
  if (!from || !to) throw new ErrorHandler("from and to are required", 400);
  to = factoryDay.calendarDayEnd(to);
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
    counts: tally.countOf(fresh.vouchers, fresh.cancels), vouchers: fresh.vouchers.length + fresh.cancels.length,
    alreadySent: Math.max(0, all.vouchers.length - fresh.vouchers.length),
    ledgers: tally.ledgersOf(fresh.vouchers), problems: fresh.problems, warnings: fresh.warnings,
    sample: fresh.vouchers.slice(0, 20).map((v) => ({ type: v.type, number: v.number, date: v.date, party: v.party, lines: v.lines.map((l) => ({ ledger: l.ledger, debit: l.amount > 0 ? l.amount : 0, credit: l.amount < 0 ? -l.amount : 0 })) })),
  });
}));

/** Stamp what a batch carries, inside its transaction; any already taken aborts it. */
async function stampAll(batchId, messages, session) {
  const at = new Date();
  const byType = {};
  for (const m of messages) {
    if (m.kind === "voucher" || m.kind === "cancel") ((byType[`${m.kind}:${m.docType}`] = byType[`${m.kind}:${m.docType}`] || []).push(m.doc));
  }
  for (const [k, ids] of Object.entries(byType)) {
    const [kind, docType] = k.split(":");
    const Model = MODELS[docType]();
    const field = kind === "voucher" ? "tally.batch" : "tally.cancelBatch";
    const r = await Model.updateMany(
      { _id: { $in: ids }, $or: [{ [field]: { $exists: false } }, { [field]: null }] },
      { $set: kind === "voucher" ? { "tally.batch": batchId, "tally.at": at } : { "tally.cancelBatch": batchId, "tally.cancelAt": at } },
      { session }
    );
    if (r.modifiedCount !== ids.length) throw new ErrorHandler("Some of these documents were sent by someone else a moment ago — preview again", 409);
  }
  for (const m of messages.filter((x) => x.kind === "application")) {
    const list = m.docType === "Payment" ? "allocations" : "applications";
    const when = m.docType === "Payment" ? "appliedAt" : "at";
    const r = await MODELS[m.docType]().updateOne(
      { _id: m.doc },
      { $set: { [`${list}.$[a].tallyBatch`]: batchId } },
      { session, arrayFilters: [{ [`a.${when}`]: m.at, "a.doc": m.target, "a.tallyBatch": null }] }
    );
    if (r.modifiedCount !== 1) throw new ErrorHandler("A credit application was sent by someone else a moment ago — preview again", 409);
  }
}

router.post("/tally/export", catchAsyncErrors(async (req, res, next) => {
  let p;
  try { p = period(req.body || {}); } catch (err) { return next(err); }
  const lock = !!req.body?.lock;
  const via = req.body?.via === "connector" ? "connector" : "file";
  if (lock && req.user?.role !== "admin") return next(new ErrorHandler("Only an admin can lock the books", 403));
  const L = await ledgerNames();
  const { vouchers, cancels, problems, partyInfo } = await tally.build({ ...p, fresh: true, L });
  if (problems.length) return next(new ErrorHandler(`Some vouchers would not balance: ${problems.slice(0, 3).join("; ")}`, 409));
  if (!vouchers.length && !cancels.length) return next(new ErrorHandler("Nothing new to send for this period", 409));
  if (via === "connector") {
    const s = await getSettings();
    if (!s.connector?.keyHash) return next(new ErrorHandler("Set up the connector first, or download the file", 409));
  }
  const company = L.companyName || (await getDocumentSettings()).companyName || "";
  const masters = req.body?.masters ? { ...tally.partiesOf(vouchers), debtorsGroup: L.debtorsGroup || "Sundry Debtors", creditorsGroup: L.creditorsGroup || "Sundry Creditors" } : null;
  const messages = tally.messagesOf({ vouchers, cancels, masters, partyInfo });
  const xml = envelope(messages.map((m) => m.xml), { company, masters: !!masters });
  const batchNo = await nextNumber("tally-batch", async () => (await TallyBatch.findOne({}).sort({ batchNo: -1 }).select("batchNo").lean())?.batchNo ?? 0);
  const _id = new mongoose.Types.ObjectId();
  try {
    await withTxn(async (session) => {
      await TallyBatch.create([{
        _id, batchNo, from: p.from, to: p.to, counts: tally.countOf(vouchers, cancels), vouchers: vouchers.length, cancels: cancels.length,
        docs: [...vouchers.filter((v) => v.kind === "voucher"), ...cancels].map((v) => ({ docType: v.docType, doc: v.doc, number: v.number })),
        ledgers: tally.ledgersOf(vouchers), lockedUpTo: lock ? p.to : null, by: req.user?._id, byName: req.user?.name || "",
        xml, company, messages, delivery: { via, status: via === "connector" ? "queued" : "file" },
      }], { session });
      await stampAll(_id, messages, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  if (lock) {
    const current = (await getSettings()).lockDate;
    if (!current || new Date(current) < p.to) {
      await AccountsSettings.updateOne({ key: "accounts" }, { $set: { lockDate: factoryDay.calendarDay(p.to.toISOString().slice(0, 10)), lockedBy: req.user?.name || "", lockedAt: new Date() } });
    }
  }
  const out = await TallyBatch.findById(_id).lean();
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

router.post("/tally/batches/:id/requeue", isAdmin("admin"), catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Batch not found", 404));
  const r = await TallyBatch.updateOne({ _id: req.params.id, "delivery.via": "connector", "delivery.status": { $in: ["queued", "sending"] } }, { $set: { "delivery.status": "queued" }, $unset: { "delivery.startedAt": "" } });
  if (!r.matchedCount) return next(new ErrorHandler("Only a batch still waiting for the connector can be queued again", 409));
  res.json({ success: true });
}));

// ── The connector ───────────────────────────────────────────────────
const connectorView = (c = {}) => ({
  configured: !!c.keyHash, keyHint: c.keyHint || "", createdAt: c.createdAt || null, lastSeenAt: c.lastSeenAt || null,
  online: !!(c.lastSeenAt && Date.now() - new Date(c.lastSeenAt).getTime() < 3 * 60_000), tallyOk: !!c.tallyOk, version: c.version || "",
});

router.get("/tally/connector", catchAsyncErrors(async (_req, res) => {
  const s = await getSettings();
  res.json({ success: true, connector: connectorView(s.connector) });
}));

router.post("/tally/connector/key", isAdmin("admin"), catchAsyncErrors(async (_req, res) => {
  await getSettings();
  const key = crypto.randomBytes(32).toString("hex");
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");
  const s = await AccountsSettings.findOneAndUpdate({ key: "accounts" }, { $set: { "connector.keyHash": keyHash, "connector.keyHint": key.slice(-4), "connector.createdAt": new Date() } }, { new: true }).lean();
  res.status(201).json({ success: true, key, connector: connectorView(s.connector) });
}));

router.delete("/tally/connector/key", isAdmin("admin"), catchAsyncErrors(async (_req, res) => {
  await AccountsSettings.updateOne({ key: "accounts" }, { $set: { "connector.keyHash": "", "connector.keyHint": "" } });
  res.json({ success: true });
}));

router.get("/tally/connector/script", catchAsyncErrors(async (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="tally-connector.js"');
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "..", "tools", "tally-connector", "tally-connector.js"));
}));

// ── Tally against these books ──────────────────────────────────────
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A party's ledger balance from the documents already sent (and the opening, which came from Tally). */
async function sentBalances(partyType) {
  const PartyLedgerEntry = require("../models/PartyLedgerEntry");
  const rows = await PartyLedgerEntry.find({ partyType }).select("party docType doc source debit credit").lean();
  const sent = new Set();
  const byType = {};
  // A journal's party rows are one per line, keyed by a derived id; the journal itself is `source`.
  const docOf = (r) => String(r.docType === "Journal" && r.source ? r.source : r.doc);
  for (const r of rows) if (MODELS[r.docType] && r.docType !== "OpeningBalance") (byType[r.docType] = byType[r.docType] || new Set()).add(docOf(r));
  for (const [t, ids] of Object.entries(byType)) {
    for (const d of await MODELS[t]().find({ _id: { $in: [...ids] }, "tally.batch": { $ne: null } }).select("_id").lean()) sent.add(String(d._id));
  }
  const all = new Map(); const sentOnly = new Map(); const unsent = new Map();
  for (const r of rows) {
    const k = String(r.party);
    const v = partyType === "customer" ? (r.debit || 0) - (r.credit || 0) : (r.credit || 0) - (r.debit || 0);
    all.set(k, r2((all.get(k) || 0) + v));
    if (r.docType === "OpeningBalance" || sent.has(docOf(r))) sentOnly.set(k, r2((sentOnly.get(k) || 0) + v));
    else unsent.set(k, (unsent.get(k) || 0) + 1);
  }
  return { all, sentOnly, unsent };
}

router.get("/tally/reconcile", catchAsyncErrors(async (_req, res) => {
  const snap = await TallySnapshot.findOne({}).sort({ createdAt: -1 }).lean();
  if (!snap) return res.json({ success: true, snapshot: null, parties: [], banks: [], missing: [], onlyInTally: [] });
  const byName = new Map(snap.ledgers.map((l) => [l.name.trim().toLowerCase(), l]));
  const byLoose = new Map();
  for (const l of snap.ledgers) { const k = norm(l.name); if (!byLoose.has(k)) byLoose.set(k, []); byLoose.get(k).push(l.name); }
  const Customer = require("../models/Customer");
  const Supplier = require("../models/Supplier");
  const BankAccount = require("../models/BankAccount");
  const parties = [];
  const matched = new Set();
  for (const [partyType, Model] of [["customer", Customer], ["supplier", Supplier]]) {
    const { all, sentOnly, unsent } = await sentBalances(partyType);
    const ids = [...all.keys()];
    const docs = await Model.find({ _id: { $in: ids } }).select("name tallyName").lean();
    for (const d of docs) {
      const k = String(d._id);
      const ledgerName = (d.tallyName || d.name || "").trim();
      const l = byName.get(ledgerName.toLowerCase());
      if (l) matched.add(l.name);
      // Tally's sign: a debit balance is negative.
      const tallyBal = l ? r2(partyType === "customer" ? -l.closing : l.closing) : null;
      const appSent = sentOnly.get(k) || 0;
      parties.push({ partyType, party: k, name: d.name, tallyName: d.tallyName || "", inTally: !!l, app: all.get(k) || 0, appSent, tally: tallyBal, difference: l ? r2(tallyBal - appSent) : null, unsent: unsent.get(k) || 0 });
    }
  }
  const bankBalances = require("../services/bankBalances");
  const accounts = await bankBalances.withBalances(await BankAccount.find({ active: { $ne: false } }).lean());
  const Payment = require("../models/Payment");
  const Contra = require("../models/Contra");
  const banks = [];
  for (const a of accounts) {
    const ledgerName = (a.tallyLedger || a.name || "").trim();
    const l = byName.get(ledgerName.toLowerCase());
    if (l) matched.add(l.name);
    const unsent = await Payment.countDocuments({ account: a._id, status: "posted", $or: [{ "tally.batch": null }, { "tally.batch": { $exists: false } }] })
      + await Contra.countDocuments({ $and: [{ $or: [{ from: a._id }, { to: a._id }] }, { status: "posted" }, { $or: [{ "tally.batch": null }, { "tally.batch": { $exists: false } }] }] });
    const tallyBal = l ? r2(-l.closing) : null;
    banks.push({ account: String(a._id), name: a.name, tallyName: a.tallyLedger || "", inTally: !!l, app: a.balance, tally: tallyBal, difference: l ? r2(tallyBal - a.balance) : null, unsent });
  }
  // Ledgers the waiting export needs that Tally does not have.
  const L = await ledgerNames();
  const pending = await tally.build({ from: new Date(Date.now() - 400 * DAY), to: new Date(), fresh: true, L });
  const missing = [];
  for (const name of tally.ledgersOf(pending.vouchers)) {
    if (byName.has(name.trim().toLowerCase())) continue;
    missing.push({ ledger: name, near: (byLoose.get(norm(name)) || []).slice(0, 3) });
  }
  const debtorish = /sundry (debtors|creditors)/i;
  const onlyInTally = snap.ledgers.filter((l) => debtorish.test(l.parent) && !matched.has(l.name) && Math.abs(l.closing) >= 0.01).slice(0, 200);
  res.json({ success: true, snapshot: { at: snap.createdAt, company: snap.company, count: snap.count }, parties, banks, missing, onlyInTally });
}));

module.exports = router;
