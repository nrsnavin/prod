'use strict';
// ════════════════════════════════════════════════════════════════
//  CREATE A SHIFT PLAN — whole, or not at all
//
//  One plan writes three collections: the ShiftPlan, a ShiftDetail per
//  machine, and the running job's list of shifts. (It used to write a
//  fourth, each operator's Employee.shifts; that array is no longer
//  written — see models/Employee.js.)
//
//  It is one transaction, so a failure part-way — a bad row, a
//  validation error, a dropped connection — leaves nothing behind.
//
//  The details are created with create(), one by one, rather than
//  insertMany: the audit plugin (models/plugins/auditFields.js) stamps
//  createdBy on save, not on insertMany, and a batched insert would have
//  dropped it silently. The references are batched where the plugin
//  still fires — one update per job, not per machine.
//
//  Used by POST /shift/create-shift-plan and by a floor sheet read from
//  a photo when its shift had no plan (services/slipIngest.js).
// ════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ShiftPlan = require('../models/ShiftPlan');
const ShiftDetail = require('../models/ShiftDetail');
const Machine = require('../models/Machine');
const JobOrder = require('../models/JobOrder');
const ErrorHandler = require('../utils/ErrorHandler');

/**
 * @param {object} input
 *   date       anything new Date() reads; the plan is for that UTC day
 *   shiftType  'DAY' | 'NIGHT'
 *   description
 *   machines   [{ machine, operator }] — ids; rows missing either are skipped
 * @returns {Promise<{ shiftPlan, detailCount }>}
 * @throws ErrorHandler 400 for bad input, 409 when the shift already has a plan
 */
async function createShiftPlan({ date, shiftType, description = '', machines = [] }) {
  if (!date || !shiftType) throw new ErrorHandler('date and shiftType are required.', 400);
  if (!Array.isArray(machines) || machines.length === 0) {
    throw new ErrorHandler('At least one machine must be assigned.', 400);
  }

  // Rows missing a machine or an operator have always been skipped. A
  // row naming something that is not an id is refused up front, before
  // anything is written, rather than failing inside the loop.
  const rows = machines.filter((m) => m && m.machine && m.operator);
  const bad = rows.find((m) =>
    !mongoose.Types.ObjectId.isValid(String(m.machine)) || !mongoose.Types.ObjectId.isValid(String(m.operator))
  );
  if (bad) throw new ErrorHandler('Every row needs a valid machine and operator.', 400);

  const planDate = new Date(date);
  if (Number.isNaN(planDate.getTime())) throw new ErrorHandler('date is not a valid date.', 400);
  planDate.setUTCHours(0, 0, 0, 0);

  const session = await mongoose.startSession();
  let shiftPlan;
  let detailCount = 0;
  try {
    await session.withTransaction(async () => {
      // Everything is derived inside the callback: withTransaction may
      // run it again after a transient error, and a retry must start
      // from nothing rather than from the aborted attempt's arrays.
      [shiftPlan] = await ShiftPlan.create([{
        date: planDate, shift: shiftType,
        description: String(description).trim(), status: 'draft',
      }], { session });

      const machineDocs = await Machine.find({ _id: { $in: rows.map((m) => m.machine) } })
        .select('elastics orderRunning').session(session).lean();
      const byId = new Map(machineDocs.map((m) => [String(m._id), m]));

      const detailIds = [];
      const byJob = new Map();       // job id → [detail ids]

      for (const m of rows) {
        const machineDoc = byId.get(String(m.machine));
        // A head the editor left empty is stored as `elastic: null`, and
        // a ShiftDetail requires an elastic on every head it lists — so a
        // partly threaded loom used to make this whole route throw. An
        // empty head produces nothing; it is not a line on the sheet.
        const elastics = (machineDoc?.elastics || [])
          .filter((e) => e && e.elastic)
          .map((e) => ({ head: e.head, elastic: e.elastic?._id ?? e.elastic }));

        const [detail] = await ShiftDetail.create([{
          date: planDate, shift: shiftType,
          // The machine's running job, or nothing. This used to fall back
          // to `m.machine` when the machine was idle, which put a MACHINE
          // id in a field declared as a JobOrder.
          job: machineDoc?.orderRunning ?? null,
          machine: m.machine, employee: m.operator,
          shiftPlan: shiftPlan._id, elastics,
          status: 'open', timer: '00:00:00',
        }], { session });

        detailIds.push(detail._id);
        if (machineDoc?.orderRunning) {
          const k = String(machineDoc.orderRunning);
          byJob.set(k, [...(byJob.get(k) || []), detail._id]);
        }
      }

      await ShiftPlan.updateOne(
        { _id: shiftPlan._id },
        { $push: { plan: { $each: detailIds } } },
        { session }
      );
      // Keep the job's own list true. The job page reads shifts by their
      // `job` ref, but an array nothing maintains is how it came to be a
      // fact-shaped empty in the first place.
      for (const [job, ids] of byJob) {
        await JobOrder.updateOne({ _id: job }, { $addToSet: { shiftDetails: { $each: ids } } }, { session });
      }
      detailCount = detailIds.length;
    });
  } catch (err) {
    if (err.code === 11000) throw new ErrorHandler('A shift plan already exists for this date and shift type.', 409);
    if (err.name === 'ValidationError' || err.name === 'CastError') throw new ErrorHandler(err.message, 400);
    throw err;
  } finally {
    await session.endSession();
  }
  return { shiftPlan, detailCount };
}

module.exports = { createShiftPlan };
