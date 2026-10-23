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
  "It should show a loom's run-time meter. The operator needs the loom's RUN TIME",
  'for the shift: how long the loom ran.',
  '',
  'THE METER ON THESE LOOMS: a SELEC LTC9A time counter — a small white or grey box with',
  '"SELEC" and "LTC9A" printed above a grey LCD window, and an orange reset button to the',
  'right of the window. The LCD shows the run time as HOURS:MINUTES:SECONDS in black',
  'seven-segment digits, e.g. "0:44:17" is 0 hours 44 minutes 17 seconds, "7:45:12" is',
  '7 hours 45 minutes 12 seconds. How to read it:',
  '- The digits are right-aligned. Leading hour digits are BLANK, not zero: an hour figure',
  '  under 10 shows as one digit ("0:44:17", "7:05:30"). Never add digits that are not lit.',
  '- Read from the RIGHT: the last two digits are seconds, the two before them are minutes,',
  '  and everything left of that is hours. Minutes and seconds are always two digits, 00-59.',
  '- The two colons are small and faint, often just two dots between the groups. They are',
  '  always there. ALWAYS write the text with both colons, as H:MM:SS ("0:44:17"), even when',
  '  you cannot see them clearly. Never write "04417", "0 44 17" or "44:17".',
  '- "SELEC", "LTC9A" and any other printed text are labels, not readings. Never list them',
  '  as a display. The orange button is a reset key, not a digit.',
  '- Seven-segment digits are easy to mix up: 1 and 7 (7 has a top bar), 4 and 9 (9 has a',
  '  top bar), 5 and 6 (6 has the lower-left bar), 6, 8, 9 and 0 (check the middle and',
  '  lower-left bars), 3 and 9. A segment can look missing in glare or at an angle. When a',
  '  digit could be one of these, put the other full reading(s) in alternatives.',
  '- A minute or second figure over 59 cannot be right: re-read it, and lower your confidence.',
  '',
  'If the photo shows a different kind of meter, read it the same way: a run time as',
  'hours and minutes (like 07:45 or 7:45:12), or a total-hours meter (like 01234.6 h).',
  '',
  'List EVERY numeric display or readout you can see. For each one give:',
  '- text: the reading, for the LTC9A as H:MM:SS with both colons; for anything else the',
  '  characters as shown, including ":" and "." (e.g. "1234.6", "58213").',
  '- kind: "run_time" (a running time for this shift; the LTC9A is always this), "hour_meter"',
  '  (total hours ever run, a large decimal), "clock" (time of day), "counter" (picks, metres,',
  '  pieces) or "other".',
  '- label: any printed word naming the reading (e.g. "RUN", "HRS", "TIME", "PICK"), or "".',
  '  The maker and model name ("SELEC", "LTC9A") is not a label: use "".',
  '- confidence: 0 to 1, how sure you are of every digit.',
  '- alternatives: other full readings of the same display if a digit is unclear, in the',
  '  same H:MM:SS form (e.g. ["0:44:11"] when the last 7 might be a 1), else [].',
  '',
  'Also give:',
  '- primary: the index (0-based) of the display most likely to be the run time, or null.',
  '- problem: null, or one of "blurry", "glare", "cut_off", "too_dark", "no_display" when the',
  '  photo itself stops you reading it.',
  '',
  'Never invent a display or a digit. If you cannot read one, leave it out.',
  'Return ONLY JSON, no prose, no markdown fences:',
  '{"displays":[{"text":"0:44:17","kind":"run_time","label":"","confidence":0.95,"alternatives":[]}],"primary":0,"problem":null}',
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

/**
 * An LTC9A run time as H:MM:SS, however the model wrote it. The meter
 * always shows three groups; a reply that lost the faint colons
 * ("04417", "0 44 17", "0.44.17") is put back together from the right —
 * seconds, minutes, then hours — as long as minutes and seconds are
 * 00-59. A reading already written with colons is left exactly as read.
 */
function asHms(text) {
  const t = String(text || '').trim();
  if (/^\d{1,5}:\d{2}:\d{2}$/.test(t) || /^\d{1,5}:\d{2}$/.test(t)) return t;
  let m = t.match(/^(\d{1,5})[\s.:]+(\d{2})[\s.:]+(\d{2})$/);
  if (!m) {
    const bare = t.match(/^(\d{1,3})(\d{2})(\d{2})$/);
    if (!bare) return t;
    m = bare;
  }
  if (Number(m[2]) > 59 || Number(m[3]) > 59) return t;
  return `${m[1]}:${m[2]}:${m[3]}`;
}

/**
 * Printed words the model sometimes lists as a reading — the meter's
 * own "LTC9A". A display is digits with ":" "." or an "h"; one with any
 * other letter in it is a label, not a number.
 */
const isLabelText = (text) => /[a-gi-z]/i.test(String(text || '').replace(/\s*h(rs?)?$/i, ''));
const clamp01 = (x) => (Number.isFinite(Number(x)) ? Math.min(1, Math.max(0, Number(x))) : 0);

/**
 * Whatever the model said, the client gets a bounded, well-typed shape:
 * at most 6 displays, short strings, known kinds, a valid index.
 */
function sanitise(raw) {
  const kept = (Array.isArray(raw?.displays) ? raw.displays : [])
    .slice(0, 6)
    .map((d, at) => {
      const kind = KINDS.has(d?.kind) ? d.kind : 'other';
      // A run time is H:MM:SS on these looms (see PROMPT).
      const tidy = (t) => (kind === 'run_time' ? asHms(clip(t, 24)) : clip(t, 24));
      const text = tidy(d?.text);
      return {
        at,
        display: {
          text,
          kind,
          label: /^(selec|ltc9a)$/i.test(clip(d?.label, 20)) ? '' : clip(d?.label, 20),
          confidence: clamp01(d?.confidence),
          alternatives: [...new Set((Array.isArray(d?.alternatives) ? d.alternatives : [])
            .map(tidy).filter((a) => a && a !== text))].slice(0, 3),
        },
      };
    })
    .filter(({ display: d }) => /\d/.test(d.text) && !isLabelText(d.text));
  const displays = kept.map((k) => k.display);

  // `primary` named a place in the model's list; displays dropped above
  // move everything after them, so it follows its display. One that was
  // dropped (the printed "LTC9A") or never existed falls back to the
  // first run time, then the first display.
  const p = Number.isInteger(raw?.primary) ? raw.primary : null;
  let primary = p == null ? -1 : kept.findIndex((k) => k.at === p);
  if (primary < 0) primary = displays.findIndex((d) => d.kind === 'run_time');
  if (primary < 0) primary = displays.length ? 0 : null;
  return {
    displays,
    primary,
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

module.exports = { readTimerPhoto, sanitise, asHms, PROMPT, SUPPORTED };
