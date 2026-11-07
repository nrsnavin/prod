'use strict';
// ══════════════════════════════════════════════════════════════════
//  A STOREKEEPER'S LINE, READ INTO A STOCK MOVEMENT
//
//  "issue 20 kg 40s black to job 512", "received 6 bags spandex lot SP77",
//  "job 512 returned 3 kg 40s PC black" — spoken into the phone (the
//  browser writes it down) or typed.
//
//  read(text) → { draft, problems[], by }
//    draft  { action: issue | receive | return, quantity, unit,
//             material {_id,name,unit,stock} | null, candidates[],
//             job {_id,jobOrderNo,status} | null, jobNo,
//             lot {_id,lotNo,balance} | null, lotNo }
//  Rules read it first; only a line they cannot read goes to the model
//  (which also copes with Tamil or Hinglish). The material is always
//  matched by code against the master, where a number conflict is
//  fatal: "30s black" is never 40s. Nothing moves until the person
//  confirms, through the same stock adjustment the screen uses.
// ══════════════════════════════════════════════════════════════════

const RawMaterial = require('../models/RawMaterial');
const JobOrder = require('../models/JobOrder');
const YarnLot = require('../models/YarnLot');
const { rank } = require('../utils/fuzzyMatch');
const { parseJson } = require('../utils/docRead');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');

const ACTIONS = [
  ['return', /\b(return(ed|s)?|came back|sent back|back to stores?)\b/],
  ['issue', /\b(issue[ds]?|give|gave|given|send|sent|take out|took|consume[ds]?|draw|drew|used?)\b/],
  ['receive', /\b(receive[ds]?|got|came|arrived|inward|add(ed)?|unload(ed)?)\b/],
];
const UNIT_WORDS = { kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', cone: 'cones', cones: 'cones', bag: 'bags', bags: 'bags', box: 'boxes', boxes: 'boxes', nos: 'nos', no: 'nos', pcs: 'nos', pieces: 'nos', m: 'm', metre: 'm', metres: 'm', meter: 'm', meters: 'm', roll: 'rolls', rolls: 'rolls' };
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
const STOP = /\b(issue[ds]?|give|gave|given|send|sent|take|out|took|consume[ds]?|draw|drew|used?|receive[ds]?|got|came|arrived|inward|add(ed)?|unload(ed)?|return(ed|s)?|back|to|from|for|of|the|a|an|please|stores?|into|in|on|by|and|with|today|now)\b/g;

/** The line as rules see it: action, quantity, unit, job, lot, and what is left — the material. */
function byRules(text) {
  let s = ` ${String(text || '').toLowerCase().replace(/[,]/g, ' ')} `;
  for (const [w, n] of Object.entries(NUMBER_WORDS)) s = s.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));
  const action = (ACTIONS.find(([, re]) => re.test(s)) || [])[0] || null;
  let jobNo = null; let lotNo = null; let quantity = null; let unit = null;
  s = s.replace(/\b(?:job|j)\s*(?:no\.?|number|#)?\s*[-:#]?\s*(\d{1,6})\b/, (_, n) => { jobNo = Number(n); return ' '; });
  s = s.replace(/\blot\s*(?:no\.?|number|#)?\s*[-:#]?\s*([a-z0-9][a-z0-9/-]{0,19})\b/, (_, l) => { lotNo = l.toUpperCase(); return ' '; });
  const unitAlt = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join('|');
  s = s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitAlt})\\b`), (_, q, u) => { quantity = Number(q); unit = UNIT_WORDS[u]; return ' '; });
  if (unit === 'g') { quantity = Math.round((quantity / 1000) * 1000) / 1000; unit = 'kg'; }
  const material = s.replace(STOP, ' ').replace(/\s+/g, ' ').trim();
  return { action, quantity, unit, jobNo, lotNo, material };
}

async function byModel(text) {
  const claude = anthropic();
  if (!claude) return null;
  const msg = await claude.messages.create({
    model: TEXT_MODEL, max_tokens: 200,
    messages: [{ role: 'user', content: `A storekeeper in an elastic weaving factory in India said this (it may be English, Tamil or Hinglish, written down by a phone): "${String(text).slice(0, 300)}"\nReturn ONLY JSON: {"action":"issue|receive|return|null","quantity":20,"unit":"kg|cones|bags|boxes|nos|m","material":"40s PC black","jobNo":512,"lotNo":"L2611"}. "issue" is goods leaving the stores (to a job, warping, covering); "receive" is goods coming in from a supplier; "return" is goods coming back from the floor. Use null for anything not said. Never guess a number.` }],
  });
  const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  if (!raw) return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    action: ['issue', 'receive', 'return'].includes(raw.action) ? raw.action : null,
    quantity: num(raw.quantity), unit: UNIT_WORDS[String(raw.unit || '').toLowerCase()] || null,
    material: String(raw.material || '').slice(0, 80), jobNo: num(raw.jobNo), lotNo: raw.lotNo ? String(raw.lotNo).toUpperCase().slice(0, 20) : null,
    usage: msg.usage,
  };
}

async function read(text) {
  const line = String(text || '').trim().slice(0, 300);
  let p = byRules(line); let by = 'rules'; let usage = null;
  if (!p.action || !p.quantity || p.material.length < 2) {
    const m = await byModel(line).catch(() => null);
    if (m && (m.action || m.quantity || m.material)) { p = { ...p, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v != null && v !== '')) }; by = 'model'; usage = m.usage; }
  }

  const problems = [];
  const mats = await RawMaterial.find({ archived: { $ne: true } }).select('name unit stock category').lean();
  const r = p.material ? rank(p.material, mats.map((m) => ({ id: String(m._id), label: m.name })), { limit: 4, floor: 0.4 }) : { candidates: [], confident: false };
  const byId = new Map(mats.map((m) => [String(m._id), m]));
  const pick = (id) => { const m = byId.get(id); return m ? { _id: String(m._id), name: m.name, unit: m.unit || 'kg', stock: m.stock || 0 } : null; };
  const material = r.confident ? pick(r.best.id) : (r.candidates.length === 1 ? pick(r.candidates[0].id) : null);
  const candidates = r.candidates.map((c) => pick(c.id)).filter(Boolean);

  let job = null;
  if (p.jobNo) {
    const j = await JobOrder.findOne({ jobOrderNo: p.jobNo }).select('jobOrderNo status').lean();
    if (j) job = { _id: String(j._id), jobOrderNo: j.jobOrderNo, status: j.status };
    else problems.push(`There is no job ${p.jobNo}.`);
  }
  let lot = null;
  if (p.lotNo && material) {
    const l = await YarnLot.findOne({ rawMaterial: material._id, lotNo: new RegExp(`^${p.lotNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('lotNo balance status').lean();
    if (l) lot = { _id: String(l._id), lotNo: l.lotNo, balance: l.balance || 0 };
    else problems.push(`${material.name} has no lot ${p.lotNo}.`);
  }

  if (!p.action) problems.push('Say whether it is issued, received or returned.');
  if (!p.quantity) problems.push('Say how much.');
  if (!material) problems.push(candidates.length ? 'Which material? Pick it below.' : `No material like "${p.material || '—'}" on file.`);
  if (material && p.unit && p.unit !== material.unit && !(p.unit === 'kg' && !material.unit)) problems.push(`${material.name} is kept in ${material.unit}, not ${p.unit}.`);
  if (material && p.action === 'issue' && p.quantity > material.stock) problems.push(`Only ${material.stock} ${material.unit} of ${material.name} in stock.`);
  if (lot && p.action === 'issue' && p.quantity > lot.balance) problems.push(`Lot ${lot.lotNo} has only ${lot.balance} ${material.unit} left.`);
  if (job && p.action === 'receive') problems.push('Goods from a supplier are not received against a job — did you mean returned?');

  return {
    draft: { action: p.action, quantity: p.quantity, unit: material?.unit || p.unit || null, material, candidates, job, jobNo: p.jobNo, lot, lotNo: p.lotNo, heard: line },
    problems, by, usage,
  };
}

module.exports = { read, byRules };
