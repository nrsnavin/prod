'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE JSON IN A MODEL'S REPLY
//
//  A model asked for JSON mostly sends JSON. Sometimes it wraps it in a
//  ```json fence, sometimes it says a sentence first. Thirteen services
//  each had their own few lines for getting the object out, in two
//  kinds: some looked inside a fence, some took everything from the
//  first "{" to the last "}". Each kind fails on a reply the other
//  reads — a brace in the sentence before a fence, a fence that holds
//  something else.
//
//  One reader, which does both: the fenced block if there is one and it
//  parses, otherwise first brace to last. null when there is no object
//  to be had — never a throw; every caller already falls back to its
//  own rules when the model is off, slow or wrong.
// ══════════════════════════════════════════════════════════════════

function between(body) {
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a === -1 || b <= a) return undefined;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return undefined; }
}

/**
 * @param {unknown} text  the model's reply
 * @returns {object|null} the object it carries, or null
 */
function parseJson(text) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const inFence = fenced ? between(fenced[1]) : undefined;
  if (inFence !== undefined) return inFence;
  const whole = between(s);
  return whole === undefined ? null : whole;
}

module.exports = { parseJson };
