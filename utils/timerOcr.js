'use strict';

// ══════════════════════════════════════════════════════════════════
//  READING A LOOM'S TIMER FROM A PHOTO  (Claude vision)
//
//  The operator photographs the loom's run-time display at the end of
//  the shift; this returns what the display shows, so the app can fill
//  the Run time field and ask about anything it isn't sure of.
//
//  What the model is asked for is deliberately NOT a single answer. A
//  loom panel can carry several numbers (run time, a total-hours meter,
//  a pick counter, the clock); a digit can be smudged; a meter can show
//  total hours rather than this shift's. So the model lists every
//  display it can see — the text exactly as shown, what kind of reading
//  it looks like, any printed label beside it, its confidence, and the
//  other ways an unclear digit could be read — and says which display it
//  thinks is the run time. Turning that into a run time, and deciding
//  what to ask the person, happens on the client (features/shifts/
//  timerReading.ts), where each answer can be applied instantly.
//
//  Advisory, like every vision feature here: the person confirms or
//  types the value before anything is saved.
// ══════════════════════════════════════════════════════════════════

const { anthropic, VISION_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const KINDS = new Set(['run_time', 'hour_meter', 'clock', 'counter', 'other']);
const PROBLEMS = new Set(['blurry', 'glare', 'cut_off', 'too_dark', 'no_display']);

const PROMPT = [
  'This photo was taken on the floor of an elastic (narrow-fabric) weaving plant.',
  'It should show the control panel or display of a loom. The operator needs the',
  "loom's RUN TIME for the shift: how long the loom ran, usually shown as hours and",
  'minutes (like 07:45 or 7:45:12), sometimes on a total-hours meter (like 01234.6 h).',
  '',
  'List EVERY numeric display or readout you can see. For each one give:',
  '- text: the characters exactly as shown, including ":" and "." (e.g. "07:45:12", "1234.6", "58213").',
  '- kind: "run_time" (a running time for this shift, resets each shift), "hour_meter"',
  '  (total hours ever run, a large decimal), "clock" (time of day), "counter" (picks, metres,',
  '  pieces) or "other".',
  '- label: any printed word next to it (e.g. "RUN", "HRS", "TIME", "PICK"), or "".',
  '- confidence: 0 to 1, how sure you are of the text.',
  '- alternatives: other readings of the same display if a digit is unclear',
  '  (e.g. ["01:45:12"] when the 7 might be a 1), else [].',
  '',
  'Also give:',
  '- primary: the index (0-based) of the display most likely to be the run time, or null.',
  '- problem: null, or one of "blurry", "glare", "cut_off", "too_dark", "no_display" when the',
  '  photo itself stops you reading it.',
  '',
  'Never invent a display. If you cannot read one, leave it out.',
  'Return ONLY JSON, no prose, no markdown fences:',
  '{"displays":[{"text":"07:45:12","kind":"run_time","label":"RUN","confidence":0.92,"alternatives":[]}],"primary":0,"problem":null}',
].join('\n');

function parseJsonReply(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const clamp01 = (x) => (Number.isFinite(Number(x)) ? Math.min(1, Math.max(0, Number(x))) : 0);

/**
 * Whatever the model said, the client gets a bounded, well-typed shape:
 * at most 6 displays, short strings, known kinds, a valid index.
 */
function sanitise(raw) {
  const displays = (Array.isArray(raw?.displays) ? raw.displays : [])
    .slice(0, 6)
    .map((d) => ({
      text: clip(d?.text, 24),
      kind: KINDS.has(d?.kind) ? d.kind : 'other',
      label: clip(d?.label, 20),
      confidence: clamp01(d?.confidence),
      alternatives: (Array.isArray(d?.alternatives) ? d.alternatives : [])
        .map((a) => clip(a, 24)).filter(Boolean).slice(0, 3),
    }))
    .filter((d) => /\d/.test(d.text));
  const p = Number.isInteger(raw?.primary) ? raw.primary : null;
  return {
    displays,
    primary: p != null && p >= 0 && p < displays.length ? p : (displays.length ? 0 : null),
    problem: PROBLEMS.has(raw?.problem) ? raw.problem : (displays.length ? null : 'no_display'),
  };
}

/** @returns {Promise<{available:false} | {available:true, reading, model, usage, latencyMs}>} */
async function readTimerPhoto(buffer, mimetype) {
  const claude = anthropic();
  if (!claude) return { available: false };
  if (!SUPPORTED.has(mimetype)) {
    const err = new Error('Use a JPEG, PNG or WEBP photo.');
    err.statusCode = 400;
    throw err;
  }
  const startedAt = Date.now();
  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const text = (message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const parsed = parseJsonReply(text);
  return {
    available: true,
    // An answer that isn't JSON reads as "couldn't see a display", which
    // the client turns into "type it instead" — never a guess.
    reading: sanitise(parsed || {}),
    model: VISION_MODEL,
    usage: message.usage,
    latencyMs: Date.now() - startedAt,
  };
}

module.exports = { readTimerPhoto, sanitise, PROMPT, SUPPORTED };
