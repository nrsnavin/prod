'use strict';
// ══════════════════════════════════════════════════════════════════
//  A TECH SHEET, A DRAWING OR A SAMPLE'S LABEL, READ INTO THE ELASTIC FORM
//
//  readSpec(pages) → { problem, name, widthMm, weaveType, colour, spandexEnds,
//    yarnEnds, pick, noOfHook, weight, hsn, warpSpandex, spandexCovering,
//    weftYarn, warpYarn[], unclear[], model, usage, latencyMs }
//  Yarns come back as written ({ text, weight }); services/elasticSpec
//  matches them to materials. Nothing is saved: the form is.
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const PROMPT = [
  'This is a technical specification sheet, a customer\'s drawing, or a photo of a sample of a narrow elastic (with its label or tag),',
  'from an elastic weaving factory in Tamil Nadu. Read the construction into JSON. Return ONLY JSON:',
  '{"problem":null,"name":"25mm Knitted Elastic Black","widthMm":25,"weaveType":"Knitted","colour":"Black",',
  ' "spandexEnds":40,"yarnEnds":120,"pick":12,"noOfHook":8,"weight":2.4,"hsn":"5806",',
  ' "warpSpandex":{"text":"Spandex 840D","weight":0.6},"spandexCovering":{"text":"40D nylon covering","weight":0.2},',
  ' "weftYarn":{"text":"150D polyester","weight":0.7},"warpYarn":[{"text":"40s PC black","weight":0.9}],',
  ' "unclear":["pick"],"confidence":0.8}',
  '- problem: "not_a_spec" when this is not an elastic spec, drawing or sample; "unreadable" when it is but cannot be read; else null.',
  '- name: as the sheet names it, else width + weave + colour (e.g. "25mm Knitted Elastic Black").',
  '- widthMm: the width in millimetres (convert inches: 1" = 25.4 mm). weight: grams per metre of the finished elastic.',
  '- spandexEnds / yarnEnds: rubber (spandex) ends and yarn ends in the warp. pick: picks per cm (or per inch when that is what it says — note it in unclear).',
  '- warpSpandex, spandexCovering, weftYarn, warpYarn: each yarn as written (count/denier, fibre, shade) with its weight in grams per metre when given.',
  '- Leave a field null when the sheet does not give it; never guess a number. List in unclear every field you were unsure of.',
].join('\n');

const yarn = (y) => (y && (y.text || y.weight != null) ? { text: str(y.text, 80), weight: num(y.weight) } : null);

function normalise(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_a_spec' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  return {
    problem: null,
    name: str(raw.name, 100),
    widthMm: num(raw.widthMm),
    weaveType: str(raw.weaveType, 40),
    colour: str(raw.colour, 40),
    spandexEnds: num(raw.spandexEnds),
    yarnEnds: num(raw.yarnEnds),
    pick: num(raw.pick),
    noOfHook: num(raw.noOfHook),
    weight: num(raw.weight),
    hsn: /^\d{4,8}$/.test(String(raw.hsn || '')) ? String(raw.hsn) : '',
    warpSpandex: yarn(raw.warpSpandex),
    spandexCovering: yarn(raw.spandexCovering),
    weftYarn: yarn(raw.weftYarn),
    warpYarn: (Array.isArray(raw.warpYarn) ? raw.warpYarn : []).map(yarn).filter(Boolean).slice(0, 8),
    unclear: (Array.isArray(raw.unclear) ? raw.unclear : []).map((x) => str(x, 30)).filter(Boolean),
    ...meta,
  };
}

async function readSpec(pages) {
  const r = await readJson({ pages, prompt: PROMPT, maxTokens: 1200 });
  return normalise(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

module.exports = { readSpec, normalise, PROMPT };
