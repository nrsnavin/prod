'use strict';
// ─────────────────────────────────────────────────────────────
//  What one metre of an elastic costs, and what to charge for it.
//
//  Everything on a quote is derived from this, so it lives on its own
//  and is computed in one place. The web form runs the same arithmetic
//  live as you type; the server recomputes it from the submitted
//  figures rather than trusting the browser's totals, because a price
//  the customer holds must be one this system stands behind.
//
//  THE CHAIN
//
//    per row      cost/m = grams ÷ 1000 × ₹/kg
//    material     Σ rows
//    total cost   material + conversion
//    rate         total × (1 + margin%)      ← markup ON COST
//    GST          rate × gst%
//    inclusive    rate + GST
//
//  Margin is a MARKUP ON COST, not a margin on the selling price: 20%
//  on ₹100 of cost gives ₹120, not ₹125. The two read the same in
//  conversation and differ in the invoice, so it is stated here rather
//  than left to be inferred from the arithmetic.
//
//  ROUNDING
//
//  Money is carried to 4 decimal places, not 2. A rate per metre is a
//  small number multiplied by a large quantity — at ₹7.83/m a rounding
//  error in the third place is rupees per thousand metres — so the
//  extra places are kept through the chain and the printed document
//  does its own rounding at the end. Each row is rounded before summing
//  so the line costs shown add up to the material total shown; the
//  discrepancy that introduces is below 1e-4 and cannot surface at the
//  two places anyone reads.
// ─────────────────────────────────────────────────────────────

const DP = 4;

/**
 * Round to `dp`, having first settled the binary representation.
 *
 * A decimal like 3.015 has no exact binary form: 1.005 × 3 evaluates to
 * 3.0149999999999997, and rounding that to two places gives 3.01 — a
 * paise lost on an exact half. Adding Number.EPSILON does not help,
 * because EPSILON is absolute (~2.2e-16) and the error here is relative
 * to a magnitude of 3.
 *
 * Settling at a precision well beyond the one being kept collapses the
 * tail onto the decimal the arithmetic meant, and the real rounding
 * then happens on an exact-enough number.
 */
function roundTo(n, dp) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const settled = Math.round(v * 1e9) / 1e9;
  const f = 10 ** dp;
  return Math.round(settled * f) / f;
}

function round(n) {
  return roundTo(n, DP);
}

/** A figure that must be a non-negative number; anything else is zero. */
function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Cost of one material on one metre of elastic.
 *
 * @param {number} weightGrams grams of this material in one metre
 * @param {number} ratePerKg   rupees per kilogram
 */
function rowCost(weightGrams, ratePerKg) {
  return round((positive(weightGrams) / 1000) * positive(ratePerKg));
}

/**
 * Price one metre.
 *
 * Rows with no weight or no rate cost nothing and are kept rather than
 * dropped — the form ships with four named rows and somebody may fill
 * only two of them, and a row that vanishes as you clear it would be
 * worse than one that reads zero.
 *
 * @param {object}   input
 * @param {Array}    input.materials       [{ label, weightGrams, ratePerKg }]
 * @param {number}   input.conversionCost  ₹ per metre
 * @param {number}   input.marginPercent   markup on cost
 * @param {number}   input.gstPercent
 */
function priceOneMetre({
  materials = [],
  conversionCost = 0,
  marginPercent = 0,
  gstPercent = 0,
} = {}) {
  const rows = (Array.isArray(materials) ? materials : []).map((m) => {
    const weightGrams = positive(m?.weightGrams);
    const ratePerKg   = positive(m?.ratePerKg);
    return {
      label: String(m?.label ?? '').trim(),
      weightGrams,
      ratePerKg,
      cost: rowCost(weightGrams, ratePerKg),
    };
  });

  const materialCost = round(rows.reduce((s, r) => s + r.cost, 0));
  const conversion   = round(positive(conversionCost));
  const totalCost    = round(materialCost + conversion);

  const margin = positive(marginPercent);
  const gst    = positive(gstPercent);

  // Markup on cost.
  const rateBeforeTax = round(totalCost * (1 + margin / 100));
  const marginAmount  = round(rateBeforeTax - totalCost);
  const gstAmount     = round(rateBeforeTax * (gst / 100));
  const rateInclTax   = round(rateBeforeTax + gstAmount);

  // The total weight of one metre. Worth stating on the sheet: it is
  // the figure somebody checks a recipe against, and a quote whose
  // grams do not match the product is a quote priced on the wrong cloth.
  const totalWeightGrams = round(rows.reduce((s, r) => s + r.weightGrams, 0));

  return {
    materials: rows,
    totalWeightGrams,
    materialCost,
    conversionCost: conversion,
    totalCost,
    marginPercent: round(margin),
    marginAmount,
    rateBeforeTax,
    gstPercent: round(gst),
    gstAmount,
    rateInclTax,
  };
}

/**
 * Extend a per-metre price over a quantity.
 *
 * Rounded to two places because this is a money total on a document,
 * not an intermediate figure.
 */
function extend(ratePerMetre, metres) {
  return roundTo(positive(ratePerMetre) * positive(metres), 2);
}

module.exports = { priceOneMetre, rowCost, extend, round, roundTo, DP };
