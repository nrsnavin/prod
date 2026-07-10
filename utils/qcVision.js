'use strict';
//
// Vision QC — zero-shot defect classification for elastic tape.
//
// Given a photo of woven/covered elastic and the product's spec, ask
// Claude vision to flag visible defects (weave faults, width out of spec,
// colour/shade, missing spandex ends, contamination) and pre-fill a QC
// draft the inspector then verifies. The numbers stay advisory — a human
// confirms/overrides before anything is saved (stage → verify → apply,
// exactly like the shift-sheet OCR flow).

const { anthropic, VISION_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function parseJsonReply(text) {
  if (!text) return null;
  // Strip code fences if the model wrapped the JSON.
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// spec: { name, parameters: [{ parameter, expected }] }
async function classifyDefect(imageBuffer, mimetype, spec = {}) {
  const claude = anthropic();
  if (!claude) return { available: false };
  if (!SUPPORTED.has(mimetype)) {
    throw new Error(`Unsupported image type '${mimetype}'. Use JPEG, PNG, WEBP or GIF.`);
  }

  const specText = (spec.parameters || [])
    .map((p) => `- ${p.parameter}${p.expected ? `: expected ${p.expected}` : ''}`)
    .join('\n') || '(no spec parameters on file)';

  const PROMPT =
    `You are a textile QC inspector for an elastic (narrow-fabric) plant. ` +
    `The photo shows a sample of "${spec.name || 'elastic tape'}".\n` +
    `Its quality parameters:\n${specText}\n\n` +
    `Inspect the image for visible defects: weave/knit faults, width out of spec, ` +
    `colour/shade mismatch, missing or broken spandex ends, fraying/selvedge faults, ` +
    `contamination or stains, uneven tension.\n\n` +
    `Return ONLY a JSON object:\n` +
    `{\n` +
    `  "overallResult": "pass" | "fail",\n` +
    `  "confidence": 0-100,\n` +
    `  "defectCode": short slug like "weave-fault" or "" if pass,\n` +
    `  "rejectedMetersHint": number (0 if none visible),\n` +
    `  "results": [{ "parameter": string, "expected": string, "measured": string, "pass": boolean }],\n` +
    `  "notes": one or two sentences describing what you see\n` +
    `}\n` +
    `Base "results" on the spec parameters above where you can judge them visually; ` +
    `for anything not visually assessable, still include the row with measured "not visually assessable" and pass true. ` +
    `Be honest about confidence — a photo can't measure elongation or exact width precisely.`;

  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimetype, data: imageBuffer.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonReply(text);
  if (!parsed) return { available: true, ok: false };

  const results = Array.isArray(parsed.results)
    ? parsed.results.map((r) => ({
        parameter: String(r.parameter || '').trim(),
        expected: String(r.expected ?? '').trim(),
        measured: String(r.measured ?? '').trim(),
        pass: Boolean(r.pass),
      })).filter((r) => r.parameter)
    : [];

  return {
    available: true,
    ok: true,
    overallResult: parsed.overallResult === 'fail' ? 'fail' : 'pass',
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
    defectCode: String(parsed.defectCode || '').trim(),
    rejectedMetersHint: Math.max(0, Number(parsed.rejectedMetersHint) || 0),
    results,
    notes: String(parsed.notes || '').trim(),
  };
}

module.exports = { classifyDefect, SUPPORTED };
