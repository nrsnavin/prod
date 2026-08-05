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

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAuthenticated } = require("../middleware/auth");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");

// ── Tool implementations (read-only Mongo queries) ─────────────────
const TOOLS = {
  async get_orders_at_risk({ horizonDays = 7 } = {}) {
    const cutoff = new Date(Date.now() + Number(horizonDays) * 86_400_000);
    const orders = await Order.find({ status: { $in: ["Approved", "InProgress"] } })
      .populate("customer", "name")
      .select("orderNo customer supplyDate status pendingElastic")
      .sort({ supplyDate: 1 })
      .lean();
    const now = new Date();
    return orders
      .filter((o) => o.supplyDate && new Date(o.supplyDate) <= cutoff)
      .slice(0, 20)
      .map((o) => ({
        orderNo: o.orderNo,
        customer: o.customer?.name || "—",
        status: o.status,
        supplyDate: o.supplyDate ? new Date(o.supplyDate).toISOString().slice(0, 10) : null,
        overdue: o.supplyDate ? new Date(o.supplyDate) < now : false,
        pendingMeters: (o.pendingElastic || []).reduce((s, p) => s + (p.quantity || 0), 0),
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
    const docs = await RawMaterial.find({ $expr: { $lte: ["$stock", "$minStock"] }, minStock: { $gt: 0 } })
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
    return {
      orderNo: o.orderNo, status: o.status, customer: o.customer?.name || "—",
      supplyDate: o.supplyDate ? new Date(o.supplyDate).toISOString().slice(0, 10) : null,
      ordered: (o.elasticOrdered || []).reduce((s, e) => s + (e.quantity || 0), 0),
      pending: (o.pendingElastic || []).reduce((s, p) => s + (p.quantity || 0), 0),
    };
  },

  async find_material({ query = "" }) {
    const rx = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const docs = await RawMaterial.find({ name: rx })
      .populate("supplier", "name")
      .select("name stock minStock price supplier category")
      .limit(8).lean();
    return docs.map((m) => ({
      name: m.name, category: m.category, stock: m.stock, minStock: m.minStock,
      low: m.stock <= m.minStock, price: m.price, supplier: m.supplier?.name || "—",
    }));
  },

  async get_machine_status() {
    const machines = await MachineModel.find({}).select("ID status").lean();
    const summary = { free: 0, running: 0, maintenance: 0 };
    for (const m of machines) summary[m.status] = (summary[m.status] || 0) + 1;
    return { summary, machines: machines.map((m) => ({ id: m.ID, status: m.status })) };
  },
};

const TOOL_SCHEMAS = [
  { name: "get_orders_at_risk", description: "List Approved/InProgress orders whose supply date falls within horizonDays (default 7), with pending meters and whether overdue.",
    input_schema: { type: "object", properties: { horizonDays: { type: "number" } } } },
  { name: "get_wastage_summary", description: "Wastage totals and top reasons over the last N days (default 30).",
    input_schema: { type: "object", properties: { days: { type: "number" } } } },
  { name: "get_materials_to_reorder", description: "Raw materials at or below their minimum stock, with a suggested reorder quantity and supplier.",
    input_schema: { type: "object", properties: {} } },
  { name: "find_order", description: "Look up a single order by its number.",
    input_schema: { type: "object", properties: { orderNo: { type: "number" } }, required: ["orderNo"] } },
  { name: "find_material", description: "Search raw materials by name; returns stock, min, low-stock flag and supplier.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_machine_status", description: "Count of machines by status (free/running/maintenance) and each machine's current status.",
    input_schema: { type: "object", properties: {} } },
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
};

// Same allow rule as requireFeature: an account with no explicit feature
// list (owner / legacy) defers to the role gate and keeps every tool.
function allowedToolNames(user) {
  const explicit = Array.isArray(user?.features) ? user.features : [];
  const all = Object.keys(TOOL_FEATURES);
  if (explicit.length === 0) return all;
  return all.filter((t) => TOOL_FEATURES[t].some((k) => explicit.includes(k)));
}

const SYSTEM =
  "You are Jarvis, the operations assistant for an elastic (narrow-fabric) manufacturing ERP. " +
  "Answer the admin's questions about orders, production, wastage, machines and materials by calling " +
  "the provided read-only tools, then giving a concise, direct answer with the actual numbers. " +
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

    const toolsUsed = [];
    try {
      for (let hop = 0; hop < 6; hop++) {
        const resp = await claude.messages.create({
          model: TEXT_MODEL, max_tokens: 1024, system: SYSTEM, messages,
          // The API rejects an empty tools array; a caller with no data
          // features simply gets a tool-less assistant.
          ...(tools.length ? { tools } : {}),
        });

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
                output = TOOLS[block.name] ? await TOOLS[block.name](block.input || {}) : { error: "unknown tool" };
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
        return res.json({ success: true, reply, toolsUsed: [...new Set(toolsUsed)] });
      }
      return res.json({ success: true, reply: "I looked into that but couldn't finish — try narrowing the question.", toolsUsed: [...new Set(toolsUsed)] });
    } catch (err) {
      console.error("[assistant/chat]", err.message);
      return res.status(502).json({ success: false, message: err.message });
    }
  })
);

module.exports = router;
// Exposed for the tool-scoping tests — the gate is the security boundary
// here, so it is tested directly rather than only through a live model call.
module.exports.TOOL_FEATURES = TOOL_FEATURES;
module.exports.allowedToolNames = allowedToolNames;
