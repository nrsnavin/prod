'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DOCUMENT NUMBER, AS PEOPLE WRITE IT
//
//  A customer's payment advice, their debit note and a supplier's
//  statement name documents the short way — "701", "INV-701" for
//  INV/2026-27/0701 — so a number that does not match whole is looked
//  for by the running number in it. One rule for all of them:
//
//    squash(s)       the number with its punctuation and case set aside,
//                    for comparing two written forms of the same number
//    lastNumber(s)   the running number: the last number in it — but not
//                    a financial year written after it. "701/26-27" is
//                    701; read as 27 it "matched" whichever document of
//                    the year happened to end in 27.
// ══════════════════════════════════════════════════════════════════

const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Two years running, as a financial year is written: 26-27, 2026-27,
// 2026/27, 2026-2027 (and 99-00). Looked for at every number in turn
// (a look-ahead, so "45/99-00" is tried at 45 and again at 99).
const FY_AT = /(?<!\d)(?=((?:19|20)?(\d{2})\s*[-/]\s*(?:19|20)?(\d{2})(?!\d)))/g;
function withoutFy(s) {
  let text = String(s || '');
  const cuts = [];
  for (const m of text.matchAll(FY_AT)) if ((Number(m[2]) + 1) % 100 === Number(m[3])) cuts.push([m.index, m.index + m[1].length]);
  for (const [from, to] of cuts.reverse()) text = `${text.slice(0, from)} ${text.slice(to)}`;
  return text;
}

function lastNumber(s) {
  const m = withoutFy(s).match(/(\d+)\D*$/);
  return m ? Number(m[1]) : null;
}

module.exports = { squash, lastNumber };
