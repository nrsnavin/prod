"use strict";
// ═════════════════════════════════════════════════════════════════
//  Reports — CSV serialization.
//
//  toCsv(columns, rows) renders a spreadsheet-safe CSV: RFC-4180
//  quoting (double quotes doubled, fields with comma/quote/newline
//  quoted) plus a leading apostrophe guard on values that Excel would
//  otherwise treat as a formula (=, +, -, @) — the classic CSV
//  injection vector. Numbers are emitted bare so Excel keeps them
//  numeric.
// ═════════════════════════════════════════════════════════════════

function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  let s = String(value);
  // Formula-injection guard: neutralise leading = + - @ (and tab/CR).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {Array<{key: string, header: string}>} columns
 * @param {Array<object>} rows
 * @returns {string} CSV text (CRLF line breaks)
 */
function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.header)).join(",");
  const body = (rows || []).map((row) =>
    columns.map((c) => cell(row[c.key])).join(",")
  );
  return [head, ...body].join("\r\n");
}

module.exports = { toCsv };
