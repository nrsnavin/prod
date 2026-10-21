'use strict';
//
// Put jobs already in packing on the dispatch queue.
//
// From now on a job joins the queue as it reaches packing (api/job.js).
// Jobs that were already in packing when the queue arrived never made
// that move, so they would be missing from it until they complete. This
// adds them as they would have been added: waiting for an urgency, ready
// from when they reached packing.
//
// Idempotent: a job that already has an entry is left alone. Down
// removes only the entries this migration created (marked `backfill`).

module.exports = {
  async up(db) {
    const jobs = await db.collection('joborders')
      .find({ status: 'packing' })
      .project({ jobOrderNo: 1, order: 1, customer: 1, elastics: 1, packingAt: 1, updatedAt: 1 })
      .toArray();
    if (!jobs.length) { console.log('[dispatch-backfill] no jobs in packing'); return; }

    const ids = (key) => [...new Set(jobs.map((j) => j[key]).filter(Boolean).map(String))];
    const oid = (s) => new (require('mongodb').ObjectId)(s);
    const [customers, orders] = await Promise.all([
      db.collection('customers').find({ _id: { $in: ids('customer').map(oid) } }).project({ name: 1 }).toArray(),
      db.collection('orders').find({ _id: { $in: ids('order').map(oid) } }).project({ orderNo: 1 }).toArray(),
    ]);
    const elasticIds = [...new Set(jobs.flatMap((j) => (j.elastics || []).map((e) => String(e.elastic))).filter(Boolean))];
    const elastics = await db.collection('elastics').find({ _id: { $in: elasticIds.map(oid) } }).project({ name: 1 }).toArray();
    const nameOf = (list) => new Map(list.map((x) => [String(x._id), x]));
    const cust = nameOf(customers), ord = nameOf(orders), el = nameOf(elastics);

    let added = 0;
    for (const j of jobs) {
      const names = (j.elastics || []).map((e) => el.get(String(e.elastic))?.name).filter(Boolean);
      const now = new Date();
      const res = await db.collection('dispatchitems').updateOne(
        { job: j._id },
        {
          $setOnInsert: {
            kind: 'job',
            job: j._id,
            order: j.order,
            customer: j.customer,
            customerName: cust.get(String(j.customer))?.name || '',
            ref: j.jobOrderNo != null ? `J-${j.jobOrderNo}` : 'Job',
            title: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more` : names.join(', '),
            quantity: (j.elastics || []).reduce((s, e) => s + (Number(e.quantity) || 0), 0),
            orderNo: ord.get(String(j.order))?.orderNo ?? null,
            status: 'awaiting_urgency',
            readyAt: j.packingAt || j.updatedAt || now,
            urgency: null,
            dueAt: null,
            history: [{ action: 'created', note: 'Already in packing when the dispatch queue arrived', at: now, byName: '' }],
            backfill: true,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true }
      );
      if (res.upsertedCount) added += 1;
    }
    console.log(`[dispatch-backfill] ${added} job(s) in packing added to the dispatch queue`);
  },

  async down(db) {
    const res = await db.collection('dispatchitems').deleteMany({ backfill: true });
    console.log(`[dispatch-backfill] down: removed ${res.deletedCount}`);
  },
};
