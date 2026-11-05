'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A FLOOR REMARK SAYS ABOUT THE SHIFT
//
//  The remark left with a floor entry ("beam change 40 min", "motor
//  sound, head 3 stopped", Tamil from speech or typed) is put in one of
//  a few downtime classes, with the minutes lost when it says, and
//  whether it describes a fault on the machine for the fitter. The
//  office sees the class beside the entry; a fault is offered to the
//  floor as a machine issue, one tap, never raised on its own.
//
//  Keywords first — they answer instantly and need no model. With a
//  model configured it is asked too, briefly: a slow answer is not
//  waited for, the keywords stand.
// ══════════════════════════════════════════════════════════════════

const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const SURFACE = 'floor-remark';
const KINDS = ['beam_change', 'yarn_break', 'mechanical', 'electrical', 'power_cut', 'no_operator', 'waiting_material', 'quality', 'other'];
const FAULTS = new Set(['mechanical', 'electrical']);
const AI_WAIT_MS = Number(process.env.FLOOR_REMARK_AI_MS) || 5000;

/** In the order they are tried: the first that matches is the class. */
const RULES = [
  ['power_cut', /\b(power|current|eb)\s*(cut|off|fail|gone|illa|illai)|\bpower\s*(?:was\s*)?(?:cut|off)\b|\bno\s*(power|current)\b|கரண்ட்\s*(இல்ல|கட்)|மின்\s*தடை/i],
  ['electrical', /\b(spark|shock|fuse|wiring|wire|short\s*circuit|panel|contactor|mcb|electric(?:al)?|inverter|drive\s*(?:fault|error|trip)|trip(?:ped|ping)?)\b|ஷாக்|புகை/i],
  ['waiting_material', /\b(waiting|wait)\b.*\b(yarn|beam|material|bobbin|cone|rubber)|\bno\s*(yarn|material|bobbin|cone|rubber|beam)\b|\b(yarn|material)\s*(not\s*(came|come|available)|short(?:age)?)\b/i],
  ['beam_change', /\b(beam|warp)\s*(change|changed|changing|over|finish(?:ed)?|empty|load(?:ing|ed)?)\b|\bbeam\b|பீம்/i],
  ['yarn_break', /\b(yarn|thread|rubber|spandex|elastic\s*thread)\s*(break|broke|broken|cut|cutting|snap)|\bbreak(?:s|ing|age)?\b.*\b(yarn|thread|rubber)\b|நூல்\s*(அறுந்|கட்)/i],
  ['mechanical', /\b(motor|bearing|gear|belt|needle|hook|cam|shaft|spring|bolt|roller|take[-\s]?up|crank|clutch|brake|jam(?:med)?|repair|mechanic|fitter|broke(?:n)?|noise|sound|vibrat|oil|leak)\b|சத்தம்|ரிப்பேர்|மோட்டார்/i],
  ['no_operator', /\b(no\s*(operator|worker|one|man)|operator\s*(absent|leave|not\s*came|didn'?t\s*come)|absent|on\s*leave)\b|ஆள்\s*இல்ல/i],
  ['quality', /\b(defect|quality|width|shade|weight|loose|tight|wrong\s*design|rejection|reject(?:ed)?|sample)\b/i],
];

/** Minutes lost, when the remark says: "40 min", "1.5 hr", "1 hour 20 min". */
function minutesIn(text) {
  const t = String(text || '');
  let total = 0;
  let found = false;
  // Not \b after the unit: it does not see the end of a Tamil word.
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|மணி)(?![a-z])|(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|நிமிடம்|நிமிஷம்)(?![a-z])/gi;
  let m;
  while ((m = re.exec(t))) {
    found = true;
    total += m[1] ? Number(m[1]) * 60 : Number(m[3]);
  }
  if (!found || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(Math.round(total), 12 * 60);
}

function keywordClass(text) {
  const t = String(text || '').trim();
  const kind = (RULES.find(([, re]) => re.test(t)) || ['other'])[0];
  return { kind, minutes: minutesIn(t), machineFault: FAULTS.has(kind), summary: '', ai: false };
}

function parseJson(text) {
  if (!text) return null;
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

const PROMPT = [
  'A supervisor in an elastic weaving factory in Tiruppur left this remark with a loom\'s production for',
  'the shift (typed, or spoken and turned into text: Tamil, English or mixed, with speech-to-text slips).',
  'Say what it is about. Return ONLY a JSON object, no prose:',
  '{"kind":"beam_change","minutes":40,"machineFault":false,"summary":"Beam changed, 40 minutes stopped","confidence":0.8}',
  '',
  `- kind: one of ${KINDS.join(', ')}. mechanical and electrical are faults on the loom itself; power_cut is`,
  '  the supply; no_operator nobody to run it; waiting_material no yarn, beam or rubber; quality a defect in',
  '  the tape; other anything else, including a remark that reports no stop at all.',
  '- minutes: the minutes the loom stood, only when the remark says it, else null.',
  '- machineFault: true when the fitter should look at the loom (something broken, noisy, sparking, leaking).',
  '- summary: at most 60 characters, plain English.',
  '- confidence: 0 to 1.',
].join('\n');

/**
 * The class of a remark. Never throws: the keywords stand when the model
 * is not set up, fails, or is slow.
 */
async function classify(text, { refId = null } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const base = keywordClass(t);
  const claude = anthropic();
  if (!claude) return base;
  const startedAt = Date.now();
  try {
    const call = claude.messages.create({
      model: TEXT_MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: `Remark:\n"""\n${t.slice(0, 1000)}\n"""\n\n${PROMPT}` }],
    });
    const msg = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), AI_WAIT_MS))]);
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw || !KINDS.includes(raw.kind)) throw new Error('model returned no class');
    const minutes = Number.isFinite(Number(raw.minutes)) && Number(raw.minutes) > 0 ? Math.min(Math.round(Number(raw.minutes)), 12 * 60) : base.minutes;
    const out = {
      kind: raw.kind,
      minutes,
      // A spark, a shock or smoke is always the fitter's, whatever was said back.
      machineFault: !!raw.machineFault || base.kind === 'electrical',
      summary: String(raw.summary || '').trim().slice(0, 80),
      ai: true,
    };
    await ledger.record({
      surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), refType: 'shift', refId,
      proposed: { kind: out.kind, minutes: out.minutes, machineFault: out.machineFault },
      latencyMs: Date.now() - startedAt, usage: msg.usage,
    }).catch(() => null);
    return out;
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) }).catch(() => null);
    return base;
  }
}

module.exports = { classify, keywordClass, minutesIn, KINDS, SURFACE, PROMPT };
