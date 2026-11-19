'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH MACHINE A WASTAGE ENTRY BELONGS TO
//
//  Wastage is recorded against a job, an elastic and an employee. Its
//  machine was read off the job — and a job stops pointing at a machine
//  the moment it goes to finishing (api/jobProgress.js). So every report
//  that grouped wastage by machine lost it as soon as the job left the
//  loom: the machine breakdown dropped the entry and its penalty from
//  the totals, and the root-cause page filed it under "—".
//
//  The shifts remember. The machine is, in order:
//
//    1. the one kept on the record when it was entered (new records);
//    2. the loom this employee ran this job on — their last shift on it
//       at or before the entry, else their last at all;
//    3. the loom anyone last ran this job on (an entry put against
//       somebody who has no shift on it);
//    4. the loom the job is on now.
// ══════════════════════════════════════════════════════════════════

const ShiftDetail = require('../models/ShiftDetail');

/**
 * Aggregation stages, for a pipeline over Wastage, that set `machineRef`
 * on each record. Rule 4 needs the job already joined and unwound as
 * `jobDoc`; without it the first three still apply.
 */
function machineOfWastage() {
  return [
    {
      $lookup: {
        from: ShiftDetail.collection.collectionName,
        let: { job: '$job', employee: '$employee', at: '$createdAt' },
        pipeline: [
          { $match: { $expr: { $eq: ['$job', '$$job'] } } },
          {
            $addFields: {
              theirs: { $cond: [{ $eq: ['$employee', '$$employee'] }, 1, 0] },
              before: { $cond: [{ $lte: ['$date', '$$at'] }, 1, 0] },
            },
          },
          { $sort: { theirs: -1, before: -1, date: -1 } },
          { $limit: 1 },
          { $project: { machine: 1 } },
        ],
        as: 'ranOn',
      },
    },
    {
      $addFields: {
        machineRef: {
          $ifNull: ['$machine', { $ifNull: [{ $arrayElemAt: ['$ranOn.machine', 0] }, '$jobDoc.machine'] }],
        },
      },
    },
  ];
}

/**
 * The same answer for one entry being recorded now: the loom `employeeId`
 * last ran `job` on, else the loom the job is on. Null when neither.
 */
async function machineForNewWastage(job, employeeId, session = null) {
  const ranOn = await ShiftDetail.findOne({ job: job._id, employee: employeeId })
    .sort({ date: -1 }).select('machine').session(session).lean();
  return ranOn?.machine || job.machine || null;
}

module.exports = { machineOfWastage, machineForNewWastage };
