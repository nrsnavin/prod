'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN AMOUNT WRITTEN IN WORDS, AS A NUMBER
//
//  "Rupees Nineteen Thousand Five Hundred Thirty Only", "Two Lakh
//  Fifty Thousand Rupees and Fifty Paise Only", "One Crore Twenty Lakhs"
//  — the line on a cheque that the figure in the box must agree with.
//
//  wordsToNumber(text) → 19530, 250000.5, … or null when the words are
//  not all number words (the reader got them wrong, or they are blank):
//  a null means "cannot check", never "zero".
// ══════════════════════════════════════════════════════════════════

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, ninty: 90,
};
const SCALES = { thousand: 1_000, lakh: 1_00_000, crore: 1_00_00_000 };
const SCALE_WORDS = {
  thousand: 'thousand', thousands: 'thousand',
  lakh: 'lakh', lakhs: 'lakh', lac: 'lakh', lacs: 'lakh', lakhe: 'lakh',
  crore: 'crore', crores: 'crore', cr: 'crore',
};
const HUNDRED = new Set(['hundred', 'hundreds', 'hundered']);
const FILLER = new Set(['rupees', 'rupee', 'rs', 'inr', 'only', 'and', 'of', 'the', 'amount', 'sum', 'a']);

/** The rupees of a run of number words, or null when a word is not one. */
function valueOf(tokens) {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (FILLER.has(t)) continue;
    if (t in UNITS) { current += UNITS[t]; seen = true; continue; }
    if (HUNDRED.has(t)) { current = (current || 1) * 100; seen = true; continue; }
    if (t in SCALE_WORDS) {
      total += (current || 1) * SCALES[SCALE_WORDS[t]];
      current = 0;
      seen = true;
      continue;
    }
    return null;
  }
  return seen ? total + current : null;
}

function wordsToNumber(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/\brs\.?/g, ' rs ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const p = tokens.findIndex((t) => t === 'paise' || t === 'paisa' || t === 'ps');
  if (p < 0) return valueOf(tokens);
  // The paise are the number words just before "paise": back to the
  // "and" (or "rupees") that sets them off, or to the first scale word.
  let start = p;
  while (start > 0) {
    const t = tokens[start - 1];
    if (t === 'and' || t === 'rupees' || t === 'rupee' || t in SCALE_WORDS || HUNDRED.has(t)) break;
    if (!(t in UNITS)) return null;
    start -= 1;
  }
  const paise = valueOf(tokens.slice(start, p));
  if (paise == null || paise >= 100) return null;
  const restTokens = [...tokens.slice(0, start), ...tokens.slice(p + 1)];
  const rupees = restTokens.some((t) => !FILLER.has(t)) ? valueOf(restTokens) : 0;
  if (rupees == null) return null;
  return Math.round((rupees + paise / 100) * 100) / 100;
}

module.exports = { wordsToNumber };
