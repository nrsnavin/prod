'use strict';
//
// Rebase every open order's pending quantity onto the new rule:
//     pending = ordered − PLANNED (quantity committed to job orders)
//
// The production cascade used to recompute pending as ordered − produced,
// which overwrote the planning deduction — planning 600 of 1000 dropped
// pending to 400, then producing 200 pushed it back UP to 800. Any order
// touched by production since then carries a wrong figure, so recompute
// them all from their live jobs.
//
// Cancelled jobs release their quantity; every other status holds it.
// Closed orders are left alone — their pending is history.

const HOLDING = { $nin: ['cancelled'] };

module.exports = {
  async up(db) {
    const orders = db.collection('orders');
    const jobs = db.collection('joborders');

    const cursor = orders.find({ status: { $in: ['Open', 'InProgress', 'Approved'] } });
    for await (const order of cursor) {
      const jobRows = await jobs
        .find({ order: order._id, status: HOLDING })
        .project({ elastics: 1 })
        .toArray();

      const planned = {};
      for (const j of jobRows) {
        for (const e of j.elastics || []) {
          if (!e?.elastic) continue;
          const id = e.elastic.toString();
          planned[id] = (planned[id] || 0) + (e.quantity || 0);
        }
      }

      const pending = (order.elasticOrdered || []).map((o) => ({
        elastic: o.elastic,
        quantity: Math.max(0, (o.quantity || 0) - (planned[o.elastic.toString()] || 0)),
      }));

      await orders.updateOne({ _id: order._id }, { $set: { pendingElastic: pending } });
    }
  },

  // Irreversible by design: the previous values were derived from produced
  // meters and were wrong, so there is nothing meaningful to restore.
  async down() {},
};
