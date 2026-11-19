// ══════════════════════════════════════════════════════════════════
//  ORDERS — HELPERS MORE THAN ONE ORDER FILE USES
//
//  What an order's elastics need in yarn, and giving back what a stopped
//  order was holding.
// ══════════════════════════════════════════════════════════════════

const { computeMaterialRequirement } = require("../utils/materialRequirement.js");
const { buildFingerprint, ACTION_CODES } = require("../utils/fingerprint.js");
const { releaseAllReservations } = require("../services/orderReservations");
const { releaseAllEarmarks } = require("../services/lotAllocation");
const ErrorHandler = require("../utils/ErrorHandler.js");
const JobOrder = require("../models/JobOrder.js");
const { liveJobStatus } = require("../domain/jobStatus");

// ════════════════════════════════════════════════════════════════
//  SHARED — BOM EXPANSION
// ════════════════════════════════════════════════════════════════
// Delegates to the shared MRP calculator (utils/materialRequirement.js) so
// the order and the job MRP sheet can never drift apart. That version also
// survives a deleted RawMaterial: this one crashed on `material._id` when
// populate handed back null for a dangling reference, and silently dropped
// the line when it didn't.
async function computeRawMaterialRequired(elasticOrdered) {
  return computeMaterialRequirement(elasticOrdered);
}

// ════════════════════════════════════════════════════════════════
//  SHARED — RELEASE ALL REMAINING RESERVATIONS
//
//  Called from /cancel and /complete. For each entry in
//  order.reservations, post a RESERVATION_RELEASE: the promise is
//  given up, and the goods it was holding become available again.
//  No goods move — they were never taken. Clears the array on the
//  order. Fingerprints (STOCK_RELEASED) appended to the order so
//  the timeline shows the release event.
// ════════════════════════════════════════════════════════════════
// Delegates to services/orderReservations.js.
//
// This used to BE the implementation, and it was the only one — so the
// other door into Completed (the last job finishing, which cascades
// through applyOrderStatus in api/job.js) released nothing at all, and
// the reserved stock stayed held for a finished order forever. Moving
// it to a service was the point: one implementation, both callers.
async function _releaseAllReservations(session, order, actor, context) {
  // Dye-lot earmarks are released through the same door, and for the
  // same reason the elastic reservations are: an order that has stopped
  // needing yarn must stop holding it. A Completed order's lots were
  // drawn by its warping batches; a Cancelled one's were never drawn at
  // all. Either way the promise is over, and an earmark nobody releases
  // is yarn on the rack that no other order can plan against.
  //
  // Mutates the order without saving, like releaseAllReservations —
  // both callers save it afterwards along with their own writes.
  const earmarked = releaseAllEarmarks(order);
  if (earmarked > 0) {
    order.fingerprints.push(buildFingerprint(ACTION_CODES.STOCK_RELEASED, {
      entityId: order._id,
      actor,
      meta: { lotEarmarks: true, quantity: earmarked, unit: 'kg', context },
    }));
  }

  return releaseAllReservations(session, order, actor, context);
}

// ════════════════════════════════════════════════════════════════
//  SHARED — AN ORDER IS NOT ENDED OUT FROM UNDER ITS JOBS
//
//  Called from /complete and /cancel. Both end the order for good, and
//  both give back what it was holding; neither may do so while one of
//  its jobs is still live.
//
//  /complete had this rule (an order closed with a job still on a
//  machine released stock reserved for goods that were still being
//  made). /cancel did not — and went further: it also put back ALL the
//  yarn drawn at approval, while the jobs it left running went on
//  weaving that yarn, holding their machines, with their warping and
//  covering still open, for an order that no longer existed.
//
//  A CANCELLED job counts as finished, like a completed one: it will
//  never produce anything. An order with no jobs at all passes.
//
//  `toDo` is how the message ends: what the caller wants done with the
//  jobs first.
// ════════════════════════════════════════════════════════════════
async function assertNoOpenJobs(order, session, toDo) {
  const openJobs = await JobOrder.find({
    order: order._id,
    status: liveJobStatus(),
  }).select("jobOrderNo status").session(session).lean();
  if (openJobs.length === 0) return;

  const one = openJobs.length === 1;
  const named = openJobs
    .map((j) => `J-${j.jobOrderNo ?? "?"} (${j.status})`)
    .join(", ");
  const err = new ErrorHandler(
    `This order still has ${openJobs.length} unfinished job${one ? "" : "s"} — ${named}. ` +
    toDo(one ? "it" : "them"),
    409
  );
  err.code = "ORDER_HAS_OPEN_JOBS";
  err.details = {
    jobs: openJobs.map((j) => ({
      id: String(j._id), jobOrderNo: j.jobOrderNo ?? null, status: j.status,
    })),
  };
  throw err;
}

module.exports = {
  computeRawMaterialRequired,
  _releaseAllReservations,
  assertNoOpenJobs,
};
