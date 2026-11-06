"use strict";
// ══════════════════════════════════════════════════════════════════
//  OPENING BALANCES, SET ONCE FROM THE DASHBOARD
//
//  The first thing the office does when the books start here: say, for
//  every customer and supplier, what was owed either way on that day.
//  A party is set once it has a posted opening balance, or someone has
//  said nothing was owed (models/OpeningNone.js). The dashboard lists
//  those not set yet; each drops off as it is set, and when none is
//  left the whole thing is done for good (completedAt) — a customer
//  added next month is a new customer, not onboarding. An admin may
//  also stop it with parties still left.
// ══════════════════════════════════════════════════════════════════

const AccountsSettings = require("../models/AccountsSettings");
const OpeningBalance = require("../models/OpeningBalance");
const OpeningNone = require("../models/OpeningNone");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const { escapeRegex } = require("../utils/escapeRegex");

const TZ = process.env.FACTORY_TZ || "Asia/Kolkata";

/** The day before this financial year began (31 March), as YYYY-MM-DD. */
function defaultAsOn(now = new Date()) {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(now).split("-").map(Number);
  return `${m >= 4 ? y : y - 1}-03-31`;
}

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function settings() {
  // Made if missing, so finishing below always has a row to mark.
  const s = await AccountsSettings.findOneAndUpdate({ key: "accounts" }, { $setOnInsert: { key: "accounts" } }, { upsert: true, new: true, projection: { openingOnboarding: 1 } }).lean();
  return s?.openingOnboarding || {};
}

/** Every party that counts, and which of them are set. */
async function parties() {
  const [customers, suppliers, cSet, sSet, none] = await Promise.all([
    Customer.find({ archived: { $ne: true }, houseStock: { $ne: true } }).select("name gstin").sort({ name: 1 }).lean(),
    Supplier.find({ isActive: { $ne: false } }).select("name gstin").sort({ name: 1 }).lean(),
    OpeningBalance.distinct("customer", { partyType: "customer", status: "posted" }),
    OpeningBalance.distinct("supplier", { partyType: "supplier", status: "posted" }),
    OpeningNone.find({}).select("partyType party").lean(),
  ]);
  const set = {
    customer: new Set([...cSet, ...none.filter((x) => x.partyType === "customer").map((x) => x.party)].map(String)),
    supplier: new Set([...sSet, ...none.filter((x) => x.partyType === "supplier").map((x) => x.party)].map(String)),
  };
  const left = (rows, partyType) => rows.filter((p) => !set[partyType].has(String(p._id))).map((p) => ({ partyType, _id: String(p._id), name: p.name, gstin: p.gstin || "" }));
  return {
    customers: { total: customers.length, left: left(customers, "customer") },
    suppliers: { total: suppliers.length, left: left(suppliers, "supplier") },
  };
}

/**
 * Where onboarding stands, and a page of the parties still to set.
 * Finishes it, once, when none is left.
 */
async function status({ partyType = "", search = "", limit = 20, by = "" } = {}) {
  const o = await settings();
  if (o.completedAt) return { active: false, completedAt: o.completedAt, leftWhenClosed: o.leftWhenClosed || 0 };
  const p = await parties();
  const total = p.customers.total + p.suppliers.total;
  const leftCount = p.customers.left.length + p.suppliers.left.length;
  if (total === 0) return { active: false, completedAt: null };
  if (leftCount === 0) {
    const done = await AccountsSettings.findOneAndUpdate(
      { key: "accounts", "openingOnboarding.completedAt": null },
      { $set: { "openingOnboarding.completedAt": new Date(), "openingOnboarding.completedBy": by, "openingOnboarding.leftWhenClosed": 0 } },
      { new: true },
    ).lean();
    return { active: false, completedAt: done?.openingOnboarding?.completedAt || new Date(), justFinished: !!done, leftWhenClosed: 0 };
  }
  let rows = partyType === "customer" ? p.customers.left : partyType === "supplier" ? p.suppliers.left : [...p.customers.left, ...p.suppliers.left];
  const q = String(search || "").trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    rows = rows.filter((r) => re.test(r.name) || re.test(r.gstin));
  }
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return {
    active: true,
    asOn: ymd(o.asOn) || defaultAsOn(),
    asOnSaved: !!o.asOn,
    customers: { total: p.customers.total, left: p.customers.left.length },
    suppliers: { total: p.suppliers.total, left: p.suppliers.left.length },
    left: rows.slice(0, n),
    more: Math.max(0, rows.length - n),
  };
}

async function setAsOn(date) {
  await AccountsSettings.updateOne({ key: "accounts" }, { $set: { "openingOnboarding.asOn": date } }, { upsert: true });
}

/** Someone checked: nothing was owed either way. */
async function markNone(partyType, party, user) {
  await OpeningNone.updateOne(
    { partyType, party: party._id },
    { $setOnInsert: { partyType, party: party._id, partyName: party.name, by: user?._id, byName: user?.name || user?.username || "" } },
    { upsert: true },
  );
}

async function close(user) {
  const p = await parties();
  const left = p.customers.left.length + p.suppliers.left.length;
  await AccountsSettings.updateOne(
    { key: "accounts" },
    { $set: { "openingOnboarding.completedAt": new Date(), "openingOnboarding.completedBy": user?.name || user?.username || "", "openingOnboarding.leftWhenClosed": left } },
    { upsert: true },
  );
  return left;
}

module.exports = { status, setAsOn, markNone, close, defaultAsOn };
