'use strict';
//
// Building a warping plan's beams from the elastics' templates.
//
// An elastic is warped the same way every time it runs, and that recipe
// lives on the product (Elastic.warpingPlanTemplate). When a warping is
// raised for a job, the plan should start from those beams rather than
// from nothing.
//
// A job can carry more than one elastic, and each brings its own beams.
// Taking only the first elastic's template — which is what this used to
// do — silently planned a mixed job as though it were a single-product
// one, so the beams for every other elastic simply went missing and had
// to be noticed by whoever read the programme.
//
// The plan takes a COPY. Editing a template later must never rewrite a
// programme already on the floor, so nothing here links back to it.

/** Does this template carry anything worth planning from? */
function hasBeams(tpl) {
  return Boolean(
    tpl &&
    Array.isArray(tpl.beams) &&
    tpl.beams.some((b) => Array.isArray(b.sections) && b.sections.length > 0)
  );
}

const plainSection = (s) => ({
  warpYarn:  s.warpYarn,
  ends:      Number(s.ends) || 0,
  maxMeters: Number(s.maxMeters) || 0,
});

/**
 * Merge the templates of every elastic on a job into one beam list.
 *
 * Beams are renumbered sequentially across the whole plan: two elastics
 * both numbering their first beam 1 would otherwise produce a plan with
 * two beam 1s, and the beam number is how the floor tells them apart.
 * A template's internal beam pairing is remapped onto the new numbers
 * rather than dropped.
 *
 * @param {Array} entries job.elastics, with `elastic` populated
 * @returns {{ beams: Array, sources: Array<{elasticId: string, elasticName: string, beamNos: number[]}> }}
 */
function buildBeamsFromTemplates(entries = []) {
  const beams = [];
  const sources = [];

  for (const entry of entries) {
    const elastic = entry?.elastic;
    const tpl = elastic?.warpingPlanTemplate;
    if (!hasBeams(tpl)) continue;

    // Old number → new number, so pairedBeamNo still points at the beam
    // it meant within this elastic's own template.
    const renumbered = new Map();
    const usable = tpl.beams.filter((b) => Array.isArray(b.sections) && b.sections.length > 0);

    const startedAt = beams.length;
    usable.forEach((b, i) => {
      const beamNo = beams.length + 1;
      renumbered.set(b.beamNo ?? i + 1, beamNo);
      const sections = b.sections.map(plainSection);
      beams.push({
        beamNo,
        totalEnds: sections.reduce((sum, s) => sum + s.ends, 0),
        sections,
        pairedBeamNo: null,
        // Which product this beam is warping. A mixed job's programme is
        // unreadable without it, and the batch that later draws yarn for
        // this beam is attributed to the same elastic.
        elastic: elastic._id,
      });
    });

    for (let i = 0; i < usable.length; i++) {
      const paired = usable[i].pairedBeamNo;
      if (paired != null && renumbered.has(paired)) {
        beams[startedAt + i].pairedBeamNo = renumbered.get(paired);
      }
    }

    sources.push({
      elasticId:   String(elastic._id),
      elasticName: elastic.name || 'Elastic',
      beamNos:     beams.slice(startedAt).map((b) => b.beamNo),
    });
  }

  return { beams, sources };
}

module.exports = { buildBeamsFromTemplates, hasBeams };
