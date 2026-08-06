'use strict';
//
// Read-side performance indexes (Phase 3).
//
// The analytics/ETA aggregations scan 30-day windows on every request;
// without these indexes each scan is a collection walk that competes
// with transactional posting for the same working set. Shapes match the
// actual $match stages in api/order.js, api/planner.js, api/shift.js,
// api/wastage.js, api/rawMaterial.js and the DC/packing reversal
// lookups in utils/elasticStock consumers.

const INDEXES = [
  // Plant-rate + anomaly scans: { status: "closed", date: { $gte } }
  ["shiftdetails",     { status: 1, date: 1 },               "status_date"],
  // Per-machine health/ETA scans: { machine, status, date }
  ["shiftdetails",     { machine: 1, status: 1, date: 1 },   "machine_status_date"],
  // Replenishment forecast: { type: "ORDER_APPROVAL", createdAt: { $gte } }
  ["materialoutwards", { type: 1, createdAt: -1 },           "type_createdAt"],
  // Wastage root-cause windows: { createdAt: { $gte } }
  ["wastages",         { createdAt: -1 },                    "createdAt_desc"],
  // DC refund / packing delete: source-movement lookups by reference
  ["stockmovements",   { refType: 1, refId: 1, elastic: 1, type: 1 }, "ref_lookup"],
  // Elastic ledger timelines
  ["stockmovements",   { elastic: 1, createdAt: -1 },        "elastic_createdAt"],
];

const { ensureIndex } = require('../utils/ensureIndex');

module.exports = {
  async up(db) {
    for (const [coll, keys, name] of INDEXES) {
      const exists = await db.listCollections({ name: coll }).hasNext();
      if (!exists) await db.createCollection(coll);
      await ensureIndex(db, coll, keys, { name, background: true });
    }
  },

  async down(db) {
    for (const [coll, , name] of INDEXES) {
      try { await db.collection(coll).dropIndex(name); } catch (_) {}
    }
  },
};
