'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DYE LOTS A JOB IS COMMITTED TO
//
//  A lot enters the system twice, at two different moments:
//
//    • when the warping programme is written — someone picks the lot
//      each beam section will run off, because two lots meeting inside
//      one beam show as a shade band;
//    • when a warping batch is issued — the cones actually come off
//      the rack and the draw is recorded against the lot's balance.
//
//  Only the second one used to be visible anywhere. So a programme
//  could name its lots on Monday and the job, the order and the
//  warping screen would all still say "nothing recorded" on Friday —
//  the decision had been made and written down, and nothing showed it.
//  This module reads the first one.
//
//  ── What "open" means ────────────────────────────────────────────
//  A section with no lot on it is not an error and is not filled in
//  with a guess. It is OPEN: the choice has not been made yet, or the
//  yarn is undyed and has no lot to make. Those sections are counted
//  and reported, because "3 sections still open" is a fact somebody
//  can act on, whereas a blank cell is one they cannot tell apart
//  from a bug.
//
//  ── Planned is not issued ────────────────────────────────────────
//  Every row carries `source`. A planned lot says what the programme
//  intends; an issued one says what left the rack. They are never
//  merged into a single number, because the first can still change
//  and the second cannot.
// ══════════════════════════════════════════════════════════════════

const WarpingPlan = require('../models/WarpingPlan');

/** Empty per-job trail, so a job with no programme still has a shape. */
const emptyTrail = () => ({
  entries: [],
  sections: { total: 0, withLot: 0, open: 0 },
  openBeamNos: [],
  planIds: [],
});

/**
 * The lots named in the warping programmes of the given jobs.
 *
 * Grouped per (elastic, lot) rather than per section: a programme
 * commonly runs one lot across six sections of the same beam, and
 * listing it six times says nothing the beam list does not.
 *
 * @param   {Array<string|ObjectId>} jobIds
 * @returns {Promise<Map<string, ReturnType<typeof emptyTrail>>>}
 *          keyed by job id — every id asked for is present.
 */
async function plannedLotsByJob(jobIds = []) {
  const ids = [...new Set((jobIds || []).map((j) => String(j?._id || j)).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, emptyTrail()]));
  if (!ids.length) return out;

  const plans = await WarpingPlan.find({ job: { $in: ids } })
    // The beam says which elastic it warps; without it a lot cannot be
    // attributed and is reported as such rather than spread over all.
    .populate('beams.elastic', 'name')
    .populate('beams.sections.warpYarn', 'name')
    // status comes along because a lot quarantined AFTER programming is
    // exactly the thing the floor needs told before the beam is built.
    .populate('beams.sections.yarnLot', 'lotNo shade status')
    .lean();

  for (const plan of plans) {
    const trail = out.get(String(plan.job));
    if (!trail) continue;
    trail.planIds.push(String(plan._id));

    const openBeams = new Set(trail.openBeamNos);
    const byKey = new Map(trail.entries.map((e) => [e._key, e]));

    for (const beam of plan.beams || []) {
      const elasticId = beam.elastic?._id ? String(beam.elastic._id) : null;
      const elasticName = beam.elastic?.name || null;

      for (const s of beam.sections || []) {
        trail.sections.total += 1;

        // Prefer the snapshot over the populated record: the snapshot is
        // what the programme sheet printed, and it outlives the lot.
        const lotId = s.yarnLot?._id ? String(s.yarnLot._id) : (s.yarnLot ? String(s.yarnLot) : null);
        const lotNo = s.lotNo || s.yarnLot?.lotNo || '';

        if (!lotId && !lotNo) {
          trail.sections.open += 1;
          if (beam.beamNo != null) openBeams.add(beam.beamNo);
          continue;
        }

        trail.sections.withLot += 1;
        const key = `${elasticId || 'unattributed'}::${lotId || lotNo}`;
        if (!byKey.has(key)) {
          const entry = {
            _key: key,
            source: 'planned',
            planId: String(plan._id),
            elasticId,
            elasticName,
            yarnLot: lotId,
            lotNo,
            shade: s.shade || s.yarnLot?.shade || '',
            lotStatus: s.yarnLot?.status || null,
            materialId: s.warpYarn?._id ? String(s.warpYarn._id) : null,
            materialName: s.warpYarn?.name || '',
            beamNos: [],
            sections: 0,
          };
          byKey.set(key, entry);
          trail.entries.push(entry);
        }
        const entry = byKey.get(key);
        entry.sections += 1;
        if (beam.beamNo != null && !entry.beamNos.includes(beam.beamNo)) {
          entry.beamNos.push(beam.beamNo);
        }
      }
    }

    trail.openBeamNos = [...openBeams].sort((a, b) => a - b);
  }

  for (const trail of out.values()) {
    for (const e of trail.entries) {
      e.beamNos.sort((a, b) => a - b);
      delete e._key;
    }
    trail.entries.sort(
      (a, b) => (a.beamNos[0] ?? 0) - (b.beamNos[0] ?? 0) || a.lotNo.localeCompare(b.lotNo)
    );
  }
  return out;
}

/** The same, for one job. */
async function plannedLotsForJob(jobId) {
  const map = await plannedLotsByJob([jobId]);
  return map.get(String(jobId?._id || jobId)) || emptyTrail();
}

/**
 * Fold a list of lot rows down to the distinct lots in them.
 *
 * What someone chasing a shade complaint wants first, before drilling
 * into which beam it was on. Keyed by lot id when there is one and by
 * lot number when there is not, so a lot recorded only as a number on
 * an old programme still counts as itself.
 */
function distinctLots(rows = []) {
  const seen = new Map();
  for (const r of rows) {
    const key = String(r.yarnLot || r.lotNo || '');
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, {
        yarnLot: r.yarnLot || null,
        lotNo: r.lotNo || '',
        shade: r.shade || '',
        materialName: r.materialName || '',
        // A lot that is both programmed and issued is reported as
        // issued: the yarn is off the rack, which is the stronger fact.
        source: r.source || 'issued',
      });
    } else if (r.source === 'issued') {
      seen.get(key).source = 'issued';
    }
  }
  return [...seen.values()];
}

module.exports = { plannedLotsByJob, plannedLotsForJob, distinctLots, emptyTrail };
