'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT AN ORDER HAS ALREADY TAKEN OUT OF STOCK
//
//  Approving an order draws its raw material out of stock there and
//  then: `RawMaterial.stock` afterwards is the balance with this
//  order's needs already removed. Every requirement sheet drawn after
//  that point was still comparing the FULL requirement against that
//  reduced balance, so an order whose yarn had been bought, received
//  and drawn read as short of the very yarn it was standing on — and
//  the shortfall panel offered to buy it again.
//
//  The authority is the outward log, not a flag on the order: it
//  carries the quantity ACTUALLY applied, which under a forced
//  approval is less than the requirement, and it is marked `reversed`
//  when a cancel refunds it. Deriving from it means a refund shows up
//  here with nothing else to maintain.
// ══════════════════════════════════════════════════════════════════

const MaterialOutward = require('../models/MaterialOut.cjs');

/**
 * How the yarn a job drew for itself is told from yarn the stores handed
 * it. Both are JOB_CONSUMPTION rows against the job. The raise's own draw
 * (services/jobRaise.js) carries no order and is named; a stores issue
 * (api/rawMaterialStock.js) carries the order as well.
 */
const EXCESS_DRAW_REMARK = /^Excess planning on J-/;
const isExcessDraw = (row) => !row?.order && EXCESS_DRAW_REMARK.test(String(row?.remarks || ''));

const add = (map, key, qty) => { if (key && qty > 0) map.set(key, (map.get(key) || 0) + qty); };

/**
 * Raw material already drawn from stock on behalf of one order.
 *
 * @param   {ObjectId|string} orderId
 * @returns {Promise<Map<string, number>>} material id → kg drawn
 */
async function issuedForOrder(orderId, session = undefined) {
  if (!orderId) return new Map();

  const rows = await MaterialOutward.find({
    order: orderId,
    type: 'ORDER_APPROVAL',
    // A cancelled order's draw was handed back; it is not provisioning
    // anything any more.
    reversed: { $ne: true },
  })
    .select('rawMaterial quantity')
    .session(session || null)
    .lean();

  const drawn = new Map();
  for (const r of rows) {
    const key = String(r.rawMaterial ?? '');
    if (!key) continue;
    const qty = Number(r.quantity) || 0;
    if (qty > 0) drawn.set(key, (drawn.get(key) || 0) + qty);
  }
  return drawn;
}

/**
 * One job's share of its parent order's draw.
 *
 * A job is a slice of the order, and the order's material came out of
 * stock in one movement covering all of them. Splitting it by each
 * job's share of the requirement is the only division the data
 * supports — nothing records which kilo was meant for which run — and
 * on the common single-job order it is exact.
 *
 * @param {Map<string, number>} orderDrawn   material id → kg the order drew
 * @param {Array}  orderRequirement  the order's rawMaterialRequired rows
 * @param {Array}  jobRequirement    rows from computeMaterialRequirement
 * @returns {Map<string, number>} material id → kg attributable to this job
 *
 * THE METRES PLANNED PAST THE ORDER ARE LEFT OUT OF THE SPLIT. The
 * approval drew for what was ORDERED. A job that plans past the order
 * draws the yarn for its extra metres itself, and the order's stored
 * requirement is restated for the larger plan at the same moment. Split
 * on the restated figure, the approval's yarn was shared out over metres
 * it was never drawn for: on an order for 100,000 m with two jobs of
 * 60,000 m, each was credited 50 kg of the 100 — and the job inside the
 * order read 10 kg short. So what the jobs drew for themselves comes off
 * both sides: the job's need, and the order's.
 *
 * @param {object} [own]
 * @param {Map<string, number>} [own.jobExcess]    material id → kg THIS job drew for its extra metres
 * @param {Map<string, number>} [own.orderExcess]  material id → kg ALL the order's jobs drew that way
 */
function shareForJob(orderDrawn, orderRequirement = [], jobRequirement = [], own = {}) {
  const share = new Map();
  if (!orderDrawn || orderDrawn.size === 0) return share;
  const jobExcess = own.jobExcess || new Map();
  const orderExcess = own.orderExcess || new Map();

  const orderNeeds = new Map();
  for (const rm of orderRequirement || []) {
    const key = String(rm.rawMaterial ?? '');
    if (!key) continue;
    orderNeeds.set(key, (orderNeeds.get(key) || 0) + (Number(rm.requiredWeight) || 0));
  }

  for (const row of jobRequirement || []) {
    const key = String(row.rawMaterial ?? '');
    const drawn = orderDrawn.get(key) || 0;
    if (drawn <= 0) continue;

    const jobNeeds = Math.max(0, (Number(row.requiredWeight) || 0) - (jobExcess.get(key) || 0));
    const total = (orderNeeds.get(key) || 0) - (orderExcess.get(key) || 0);
    // No recorded order requirement to divide by — an order predating
    // the stored requirement, or a job carrying an elastic the order
    // does not. Attributing the whole draw would credit this job with
    // material meant for its siblings, so credit none of it and let
    // the sheet read as it did before.
    if (total <= 0) continue;

    // Never more than was drawn: a job needing more than its order's
    // stored requirement was credited with yarn nobody took out.
    share.set(key, Math.min(jobNeeds, drawn, (drawn * jobNeeds) / total));
  }
  return share;
}

/**
 * What the jobs of one order have had out of stock on top of the
 * approval draw.
 *
 *   excess — drawn by a job when it was raised past the order, for the
 *            metres it planned over (services/jobRaise.js);
 *   issued — handed to a job by the stores (api/rawMaterialStock.js),
 *            which is how the rest of a forced approval reaches the
 *            floor once it has been bought.
 *
 * Neither was counted by any sheet that says what is short. Each read a
 * job, or its order, as still owed yarn that had already left the stock
 * figure for it — and the job's sheet offered to buy it again.
 *
 * A cancelled job is left out. Its own draw went back to stock if it had
 * woven nothing (services/jobExcessReturn.js); what it keeps, and what
 * the stores issued to it, is yarn on the floor that nothing says
 * belongs to the order's other jobs.
 *
 * @returns {Promise<{
 *   byJob:  Map<string, { excess: Map<string, number>, issued: Map<string, number> }>,
 *   excess: Map<string, number>,
 *   issued: Map<string, number>,
 * }>} material id → kg throughout
 */
async function drawnByJobs(orderId, session = undefined) {
  const out = { byJob: new Map(), excess: new Map(), issued: new Map() };
  if (!orderId) return out;

  // Required here, not at the top: models/JobOrder pulls in the order
  // model, and this file is loaded by both.
  const JobOrder = require('../models/JobOrder');
  const jobs = await JobOrder.find({ order: orderId, status: { $ne: 'cancelled' } })
    .select('_id')
    .session(session || null)
    .lean();
  if (jobs.length === 0) return out;

  const rows = await MaterialOutward.find({
    job: { $in: jobs.map((j) => j._id) },
    type: 'JOB_CONSUMPTION',
    reversed: { $ne: true },
  })
    .select('rawMaterial quantity job order remarks')
    .session(session || null)
    .lean();

  for (const r of rows) {
    const key = String(r.rawMaterial ?? '');
    const qty = Number(r.quantity) || 0;
    if (!key || qty <= 0) continue;
    const jobKey = String(r.job);
    if (!out.byJob.has(jobKey)) out.byJob.set(jobKey, { excess: new Map(), issued: new Map() });
    const kind = isExcessDraw(r) ? 'excess' : 'issued';
    add(out.byJob.get(jobKey)[kind], key, qty);
    add(out[kind], key, qty);
  }
  return out;
}

/** Several material → kg maps added together. */
function sumOf(...maps) {
  const total = new Map();
  for (const m of maps) for (const [key, qty] of m || []) add(total, key, Number(qty) || 0);
  return total;
}

/**
 * Everything out of stock for one order, for a sheet of its requirement.
 *
 * `planned` says which requirement the sheet is of:
 *
 *   true  — the order's STORED requirement (the order page), which is
 *           restated for what is planned once a job goes past the
 *           order: the approval, what the jobs drew for their extra
 *           metres, and what the stores issued to them;
 *   false — what was ORDERED (the order's requirement sheet): the
 *           approval and the stores' issues. The jobs' own draws are
 *           for metres that sheet does not ask for, and counting them
 *           would hide a forced approval's real gap behind them.
 *
 * @returns {Promise<Map<string, number>>} material id → kg
 */
async function heldForOrder(orderId, { planned = false, session = undefined } = {}) {
  const approval = await issuedForOrder(orderId, session);
  const jobs = await drawnByJobs(orderId, session);
  return planned ? sumOf(approval, jobs.excess, jobs.issued) : sumOf(approval, jobs.issued);
}

/**
 * Everything out of stock for one job: its share of the order's
 * approval draw, what it drew for its own extra metres, and what the
 * stores issued to it.
 *
 * @param {object} job             lean job; `order` an id, or populated with `rawMaterialRequired`
 * @param {Array}  jobRequirement  rows from computeMaterialRequirement for the job's lines
 * @returns {Promise<Map<string, number>>} material id → kg
 */
async function heldForJob(job, jobRequirement = [], session = undefined) {
  const orderId = job?.order?._id || job?.order;
  if (!job?._id || !orderId) return new Map();

  const approval = await issuedForOrder(orderId, session);
  const jobs = await drawnByJobs(orderId, session);
  const mine = jobs.byJob.get(String(job._id)) || { excess: new Map(), issued: new Map() };

  const share = shareForJob(approval, job.order?.rawMaterialRequired || [], jobRequirement, {
    jobExcess: mine.excess,
    orderExcess: jobs.excess,
  });
  return sumOf(share, mine.excess, mine.issued);
}

module.exports = {
  issuedForOrder, shareForJob, drawnByJobs, heldForOrder, heldForJob,
  EXCESS_DRAW_REMARK, isExcessDraw,
};
