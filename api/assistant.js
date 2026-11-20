'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Conversational ops assistant ("Ask Jarvis")
//
//  A read-only agent: Claude answers plant questions by calling a small
//  set of whitelisted query tools (orders at risk, wastage drivers,
//  materials to reorder, order/material lookup). The backend executes the
//  tools against Mongo and Claude synthesises the answer. No write tools
//  in v1 — the assistant can explain and recommend, never mutate.
// ═══════════════════════════════════════════════════════════════════

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const Order        = require("../models/Order");
const Wastage      = require("../models/Wastage");
const RawMaterial  = require("../models/RawMaterial");
const Elastic      = require("../models/Elastic");
const MachineModel = require("../models/Machine");
const Customer     = require("../models/Customer");
const Supplier     = require("../models/Supplier");
const Expense      = require("../models/Expense");
const BankAccount  = require("../models/BankAccount");
const outstanding  = require("../services/outstanding");
const partyLedger  = require("../services/partyLedger");
const { escapeRegex } = require("../utils/escapeRegex");
const risk         = require("../services/deliveryRisk");
const factoryDay   = require("../utils/factoryDay");
const cal          = require("../utils/bizDates");
const { r2 }       = require("../utils/money");

// A date as the model is to read it: the day, with its year. Rows used to
// carry String(date).slice(0, 10) — "Sat Oct 03", in the server's zone.
const day = (d) => factoryDay.ymd(d);

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAuthenticated } = require("../middleware/auth");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");
const { promptVersion } = require("../utils/aiPrompts");
const ledger = require("../services/aiLedger");
const assistantReports = require("../services/assistantReports");

// ── Tool implementations (read-only Mongo queries) ─────────────────
const TOOLS = {
  // The list the delivery-risk card shows (services/deliveryRisk.js), not
  // a second reading of it. This one used to report `pendingElastic` —
  // what no job has been raised for — as the metres pending, so an order
  // planned in full with nothing made had none; and it called an order
  // late by the clock, so one due today was "overdue" from 05:30.
  async get_orders_at_risk({ horizonDays = 7 } = {}) {
    const horizon = risk.readHorizon(horizonDays);
    const now = new Date();
    const orders = await Order.find({ status: { $in: risk.OPEN_STATUSES }, supplyDate: { $lt: risk.fetchBefore(now, horizon) } })
      .populate("customer", "name")
      .select("orderNo customer status supplyDate elasticOrdered packedElastic pendingElastic")
      .lean();
    return risk.deliveryRisk(orders, { now, horizonDays: horizon }).slice(0, 20).map((o) => ({
      orderNo: o.orderNo,
      customer: o.customerName,
      status: o.status,
      supplyDate: day(o.supplyDate),
      daysToSupply: o.daysToSupply,
      overdue: o.daysToSupply < 0,
      pendingMeters: o.pendingUnits,
      notPlannedMeters: o.notPlanned,
    }));
  },

  async get_wastage_summary({ days = 30 } = {}) {
    const since = new Date(Date.now() - Number(days) * 86_400_000);
    const [byReason, totals] = await Promise.all([
      Wastage.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $ifNull: ["$reason", "(none)"] }, qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
        { $sort: { qty: -1 } }, { $limit: 6 },
        { $project: { _id: 0, reason: "$_id", qty: 1, count: 1 } },
      ]),
      Wastage.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, qty: { $sum: "$quantity" }, count: { $sum: 1 } } },
      ]),
    ]);
    return { days: Number(days), totalMeters: Math.round(totals[0]?.qty || 0), entries: totals[0]?.count || 0, topReasons: byReason };
  },

  async get_materials_to_reorder() {
    // Materials still in use: a retired one is not something to buy.
    const docs = await RawMaterial.find({ archived: { $ne: true }, $expr: { $lte: ["$stock", "$minStock"] }, minStock: { $gt: 0 } })
      .populate("supplier", "name")
      .select("name stock minStock price supplier")
      .sort({ stock: 1 })
      .limit(20)
      .lean();
    return docs.map((m) => ({
      name: m.name, stock: m.stock, minStock: m.minStock,
      suggestedQty: Math.max(m.minStock * 2 - m.stock, m.minStock),
      supplier: m.supplier?.name || "(no supplier set)",
    }));
  },

  async find_order({ orderNo }) {
    if (orderNo == null) return { error: "orderNo is required" };
    const o = await Order.findOne({ orderNo: Number(orderNo) })
      .populate("customer", "name")
      .lean();
    if (!o) return { error: `No order #${orderNo}` };
    // "pending" is what the customer is still owed (ordered less packed);
    // what no job has been raised for yet is beside it, under its own name.
    // Nothing is owed on an order that is closed: cancelled or completed, it
    // keeps its old figures on the record (as the order book has it).
    const open = risk.OPEN_STATUSES.includes(o.status);
    return {
      orderNo: o.orderNo, status: o.status, customer: o.customer?.name || "—",
      supplyDate: day(o.supplyDate),
      ordered: (o.elasticOrdered || []).reduce((s, e) => s + (e.quantity || 0), 0),
      pending: open ? risk.stillOwed(o) : 0,
      notPlanned: open ? risk.notPlanned(o) : 0,
    };
  },

  async find_material({ query = "" }) {
    const rx = new RegExp(escapeRegex(String(query ?? "").trim()), "i");
    const docs = await RawMaterial.find({ name: rx })
      .populate("supplier", "name")
      .select("name stock minStock price supplier category archived")
      .sort({ archived: 1, name: 1 })
      .limit(8).lean();
    return docs.map((m) => ({
      name: m.name, category: m.category, stock: m.stock, minStock: m.minStock,
      low: m.stock <= m.minStock, price: m.price, supplier: m.supplier?.name || "—",
      retired: m.archived === true,
    }));
  },

  // ── The books (Accounts) ──
  async get_receivables({ customer } = {}) {
    const rows = await outstanding.receivables();
    const groups = outstanding.byParty(rows);
    const pick = customer ? groups.filter((g) => new RegExp(escapeRegex(String(customer)), "i").test(g.partyName)) : groups;
    return {
      totals: outstanding.totals(customer ? pick.flatMap((g) => g.docs) : rows),
      byCustomer: pick.slice(0, 15).map((g) => ({ customer: g.partyName, outstanding: g.total, overdue: g.overdue, oldestDays: g.oldestDays, invoices: g.docs.slice(0, 8).map((d) => ({ no: d.docNo, date: day(d.date), outstanding: d.outstanding, overdueDays: d.overdueDays })) })),
    };
  },
  async get_payables({ supplier } = {}) {
    const rows = await outstanding.payables();
    const groups = outstanding.byParty(rows);
    const pick = supplier ? groups.filter((g) => new RegExp(escapeRegex(String(supplier)), "i").test(g.partyName)) : groups;
    return {
      totals: outstanding.totals(supplier ? pick.flatMap((g) => g.docs) : rows),
      bySupplier: pick.slice(0, 15).map((g) => ({ supplier: g.partyName, outstanding: g.total, overdue: g.overdue, oldestDays: g.oldestDays, bills: g.docs.slice(0, 8).map((d) => ({ no: d.docNo, theirNo: d.refNo || "", date: day(d.date), outstanding: d.outstanding, overdueDays: d.overdueDays })) })),
    };
  },
  async get_party_statement({ name, partyType = "customer", days = 90 } = {}) {
    const Model = partyType === "supplier" ? Supplier : Customer;
    const party = await Model.findOne({ name: new RegExp(escapeRegex(String(name || "")), "i") }).select("name").lean();
    if (!party) return { error: `No ${partyType} matching "${name}"` };
    const from = new Date(Date.now() - Number(days) * 86_400_000);
    const st = await partyLedger.statement(partyType, party._id, { from });
    return { party: party.name, partyType, opening: st.opening, closing: st.closing, rows: st.rows.slice(-40).map((r) => ({ date: day(r.date), doc: r.docNo, narration: r.narration, debit: r.debit, credit: r.credit, balance: r.balance })) };
  },
  async get_expense_summary({ days = 30 } = {}) {
    const since = new Date(Date.now() - Number(days) * 86_400_000);
    const rows = await Expense.aggregate([
      { $match: { status: { $in: ["approved", "paid"] }, date: { $gte: since } } },
      { $group: { _id: "$categoryName", amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]);
    const pending = await Expense.countDocuments({ status: "pending" });
    return { days: Number(days), total: r2(rows.reduce((s, r) => s + r.amount, 0)), byHead: rows.map((r) => ({ head: r._id, amount: r2(r.amount), count: r.count })), waitingApproval: pending };
  },
  async get_cash_forecast({ weeks = 6 } = {}) {
    const f = await require("../services/accountsInsights").forecast({ weeks: Math.min(13, Math.max(2, Number(weeks) || 6)) });
    return {
      openingCash: f.opening, firstShortWeek: f.firstShortWeek,
      weeks: f.weeks.map((w) => ({ from: w.from, inflow: w.inflow, outflow: w.outflow, closing: w.closing, biggest: w.top.slice(0, 3) })),
      note: "Receipts are expected when each customer has actually paid in the past, not on the invoice due date.",
    };
  },
  async get_close_checklist({ month } = {}) {
    // A month that is one; otherwise last month by the books' calendar,
    // which the checklist works out itself. It was worked out here in the
    // server's zone: until 05:30 on the 1st, the month before last.
    const c = await require("../services/accountsInsights").closeChecklist(cal.isMonthKey(month) ? month : undefined);
    return { month: c.month, done: c.done, total: c.total, items: c.items.map((i) => ({ item: i.label, done: i.ok, detail: i.detail, amount: i.amount })) };
  },
  async get_cash_position() {
    // Not closed — as everywhere else an account is asked for. `active: true`
    // left out the accounts kept from before that flag was on them.
    const accounts = await BankAccount.find({ active: { $ne: false } }).lean();
    const rows = await require("../services/bankBalances").withBalances(accounts);
    return rows.map((a) => ({ account: a.name, kind: a.kind, balance: a.balance }));
  },

  async get_machine_status() {
    const machines = await MachineModel.find({}).select("ID status").lean();
    const summary = { free: 0, running: 0, maintenance: 0 };
    for (const m of machines) summary[m.status] = (summary[m.status] || 0) + 1;
    return { summary, machines: machines.map((m) => ({ id: m.ID, status: m.status })) };
  },
};

const TOOL_SCHEMAS = [
  { name: "get_orders_at_risk", description: "Open orders promised within horizonDays (default 7) or already past their date, that the customer is still owed goods on: pendingMeters is what is still to deliver (ordered less packed), notPlannedMeters how much of that no job has been raised for, daysToSupply the days left (negative once late).",
    input_schema: { type: "object", properties: { horizonDays: { type: "number" } } } },
  { name: "get_wastage_summary", description: "Wastage totals and top reasons over the last N days (default 30).",
    input_schema: { type: "object", properties: { days: { type: "number" } } } },
  { name: "get_materials_to_reorder", description: "Raw materials at or below their minimum stock, with a suggested reorder quantity and supplier.",
    input_schema: { type: "object", properties: {} } },
  { name: "find_order", description: "Look up a single order by its number: ordered, pending (still to deliver: ordered less packed) and notPlanned (no job raised for it yet).",
    input_schema: { type: "object", properties: { orderNo: { type: "number" } }, required: ["orderNo"] } },
  { name: "find_material", description: "Search raw materials by name; returns stock, min, low-stock flag, supplier, and whether the material is retired (no longer used).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_machine_status", description: "Count of machines by status (free/running/maintenance) and each machine's current status.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_receivables", description: "What customers owe on issued invoices, with ageing; optionally one customer by (partial) name.",
    input_schema: { type: "object", properties: { customer: { type: "string" } } } },
  { name: "get_payables", description: "What we owe suppliers on open bills and approved expenses, with ageing; optionally one supplier by (partial) name.",
    input_schema: { type: "object", properties: { supplier: { type: "string" } } } },
  { name: "get_party_statement", description: "A customer's or supplier's statement of account over the last N days (default 90): every invoice, bill, note and voucher with the running balance.",
    input_schema: { type: "object", properties: { name: { type: "string" }, partyType: { type: "string", enum: ["customer", "supplier"] }, days: { type: "number" } }, required: ["name"] } },
  { name: "get_expense_summary", description: "Expenses by head over the last N days (default 30), and how many are waiting for approval.",
    input_schema: { type: "object", properties: { days: { type: "number" } } } },
  { name: "get_cash_position", description: "The book balance of every cash and bank account.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_cash_forecast", description: "Cash in and out for the coming weeks and the week cash would run short, from how each customer actually pays, bills due and recurring expenses.",
    input_schema: { type: "object", properties: { weeks: { type: "number", description: "How many weeks ahead (2–13, default 6)" } } } },
  { name: "get_close_checklist", description: "What is left before a month's books can be closed: bank lines, uncleared cheques, bills without copies, pending approvals, TDS to deposit, documents not sent to Tally, the lock.",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM; default last month" } } } },
];

// Every tool reads a specific module's data, so Jarvis has to answer with
// the CALLER's permissions rather than the server's. Ask Jarvis is an
// always-on feature that every account holds, so without this a user whose
// admin removed /orders or /materials could still extract those records
// just by asking for them in words — walking straight around the REST
// feature gate that denies the same data over HTTP.
const TOOL_FEATURES = {
  get_orders_at_risk:       ['/orders'],
  find_order:               ['/orders'],
  get_wastage_summary:      ['/wastage'],
  get_materials_to_reorder: ['/materials'],
  find_material:            ['/materials'],
  get_machine_status:       ['/machines'],
  get_receivables:          ['/accounts'],
  get_payables:             ['/accounts'],
  get_party_statement:      ['/accounts'],
  get_expense_summary:      ['/accounts'],
  get_cash_position:        ['/accounts'],
  get_cash_forecast:        ['/accounts'],
  get_close_checklist:      ['/accounts'],
  // Any figure across the datasets, through the report engine — which
  // checks the caller's role per dataset on top of this.
  run_report:               ['/reports'],
};

// …and the ROLE gate the same data sits behind over HTTP (app.js: each
// module's `gate(...)`; admin passes every one). The feature rule below
// leaves an account with no list "to the role gate" — and this route has
// none, being open to every login. So a production login from before the
// lists, refused /accounts by its role, was told the bank balances and
// any customer's statement for the asking. Keep these beside the mounts:
//   /order → accounts · /wastage, /machine → production ·
//   /materials, /reports → production, accounts · /accounts → accounts
const TOOL_ROLES = {
  get_orders_at_risk:       ['accounts'],
  find_order:               ['accounts'],
  get_wastage_summary:      ['production'],
  get_materials_to_reorder: ['production', 'accounts'],
  find_material:            ['production', 'accounts'],
  get_machine_status:       ['production'],
  get_receivables:          ['accounts'],
  get_payables:             ['accounts'],
  get_party_statement:      ['accounts'],
  get_expense_summary:      ['accounts'],
  get_cash_position:        ['accounts'],
  get_cash_forecast:        ['accounts'],
  get_close_checklist:      ['accounts'],
  run_report:               ['production', 'accounts'],
};

// Both gates, as over HTTP. The role first. Then the same allow rule as
// requireFeature, and it has to stay the same or Jarvis becomes the way
// around it: an account with NO list at all (owner / legacy) is left to
// its role, while an explicitly EMPTY list is a deliberate "nothing".
function allowedToolNames(user) {
  const role = user?.role;
  const byRole = Object.keys(TOOL_FEATURES).filter((t) => role === 'admin' || (TOOL_ROLES[t] || []).includes(role));
  if (!Array.isArray(user?.features)) return byRole;
  const explicit = user.features;
  return byRole.filter((t) => TOOL_FEATURES[t].some((k) => explicit.includes(k)));
}

const SYSTEM =
  "You are Jarvis, the operations assistant for an elastic (narrow-fabric) manufacturing ERP. " +
  "Answer the admin's questions about orders, production, wastage, machines, materials and the books " +
  "(receivables, payables, statements, expenses, cash) by calling " +
  "the provided read-only tools, then giving a concise, direct answer with the actual numbers. " +
  "For any figure the specific tools do not cover — production by operator or loom, sales or purchases by customer, " +
  "group, item or supplier, dispatch, wastage, stock, expenses over any period — use run_report; if it errors, fix the query and try once more. " +
  "When you used run_report, say the report can be opened from your answer to download or save. " +
  "Prefer a tool call over guessing. If the data shows nothing, say so. Keep answers short (a few " +
  "sentences or a tight list). You cannot change anything — recommend actions, but note the admin must do them.";

router.post(
  "/chat",
  // Ask Jarvis is open to any authenticated user (always-on feature), but
  // the DATA it can reach is scoped per caller — see TOOL_FEATURES.
  isAuthenticated,
  catchAsyncErrors(async (req, res) => {
    const claude = anthropic();
    if (!claude) return res.status(503).json({ success: false, message: "AI assistant is not configured (no API key)." });

    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    // Keep only role/content, last 20 turns, string content only.
    const messages = incoming
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));
    if (messages.length === 0) return res.status(400).json({ success: false, message: "messages[] required" });

    // Advertise only the tools this caller may use, so the model never
    // offers data the user can't have — and enforce it again at execution
    // below, because what the model calls is not a trust boundary.
    const allowedTools = new Set(allowedToolNames(req.user));
    const tools = TOOL_SCHEMAS.filter((t) => allowedTools.has(t.name));
    const reportTool = allowedTools.has("run_report") ? assistantReports.toolFor(req.user) : null;
    if (reportTool) tools.push(reportTool); else allowedTools.delete("run_report");
    const reports = [];

    const toolsUsed = [];
    // One ledger row per QUESTION, not per hop. A tool-calling answer is
    // three or four model calls the user never sees as separate things,
    // and costing them separately would make the token figure unreadable
    // against the thing being measured — "what does an answer cost".
    const startedAt = Date.now();
    const usage = { input_tokens: 0, output_tokens: 0 };
    const logAnswer = (reply, err) => ledger.record({
      surface: "assistant-answer",
      model: TEXT_MODEL,
      promptVersion: promptVersion("assistant-answer"),
      proposed: err ? undefined : { reply, toolsUsed: [...new Set(toolsUsed)] },
      latencyMs: Date.now() - startedAt,
      usage,
      error: err,
    });

    try {
      for (let hop = 0; hop < 6; hop++) {
        const resp = await claude.messages.create({
          model: TEXT_MODEL, max_tokens: 1024, system: SYSTEM, messages,
          // The API rejects an empty tools array; a caller with no data
          // features simply gets a tool-less assistant.
          ...(tools.length ? { tools } : {}),
        });

        usage.input_tokens  += resp.usage?.input_tokens  || 0;
        usage.output_tokens += resp.usage?.output_tokens || 0;

        if (resp.stop_reason === "tool_use") {
          messages.push({ role: "assistant", content: resp.content });
          const results = [];
          for (const block of resp.content) {
            if (block.type !== "tool_use") continue;
            toolsUsed.push(block.name);
            let output;
            try {
              if (!allowedTools.has(block.name)) {
                // Second line of defence: the model was never offered this
                // tool, so reaching here means the request was steered
                // somewhere it shouldn't go. Refuse rather than read.
                output = { error: "You don't have access to this feature." };
              } else {
                if (block.name === "run_report") {
                  const r = await assistantReports.run(block.input || {}, req.user);
                  if (r.report) reports.push(r.report);
                  output = r.forModel || r;
                } else {
                  output = TOOLS[block.name] ? await TOOLS[block.name](block.input || {}) : { error: "unknown tool" };
                }
              }
            } catch (err) {
              output = { error: err.message };
            }
            results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) });
          }
          messages.push({ role: "user", content: results });
          continue;
        }

        const reply = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        await logAnswer(reply);
        return res.json({ success: true, reply, toolsUsed: [...new Set(toolsUsed)], reports });
      }
      // Six hops and no answer. Recorded as a failure because that is
      // what it is from the asker's side, however calmly it reads.
      await logAnswer(null, "hop limit reached without an answer");
      return res.json({ success: true, reply: "I looked into that but couldn't finish — try narrowing the question.", toolsUsed: [...new Set(toolsUsed)] });
    } catch (err) {
      console.error("[assistant/chat]", err.message);
      await logAnswer(null, err.message);
      return res.status(502).json({ success: false, message: err.message });
    }
  })
);

module.exports = router;
// Exposed for the tool-scoping tests — the gate is the security boundary
// here, so it is tested directly rather than only through a live model call.
module.exports.TOOL_FEATURES = TOOL_FEATURES;
module.exports.TOOL_ROLES = TOOL_ROLES;
module.exports.allowedToolNames = allowedToolNames;
