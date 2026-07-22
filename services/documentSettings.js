"use strict";

// ══════════════════════════════════════════════════════════════
//  DOCUMENT SETTINGS SERVICE
//
//  Single read path for the company profile / branding singleton,
//  with a short in-process cache so the PDF layer (which can render
//  many documents in a burst) doesn't hit Mongo on every render.
//  The Settings API calls invalidate() after a write.
// ══════════════════════════════════════════════════════════════

const DocumentSettings = require("../models/DocumentSettings");

let _cache = null;
let _cachedAt = 0;
const TTL_MS = 60 * 1000; // 60s — settings change rarely

// Fetch-or-create the singleton. Never returns null.
async function getDocumentSettings({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cachedAt < TTL_MS) return _cache;

  // upsert guarantees exactly one row (unique key:"document").
  const doc = await DocumentSettings.findOneAndUpdate(
    { key: "document" },
    { $setOnInsert: { key: "document" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  _cache = doc;
  _cachedAt = Date.now();
  return doc;
}

function invalidate() {
  _cache = null;
  _cachedAt = 0;
}

// Map the settings doc into the compact branding shape the PDF
// generators consume, so each generator doesn't need to know the full
// schema. Falls back to sane defaults if settings can't be read.
function pdfBranding(settings) {
  const s = settings || {};
  return {
    company: s.companyName || "Balu Elastics",
    tagline: s.tagline || "Elastic Manufacturing",
    accent: s.accentColor || "#1D6FEB",
    gstin: s.gstin || "",
    phone: s.phone || "",
    email: s.email || "",
    website: s.website || "",
    addressLines: Array.isArray(s.addressLines) ? s.addressLines.filter(Boolean) : [],
    footerNote: s.footerNote || "",
    logo: s.logo || "",
  };
}

// Convenience: fetch + map in one call for PDF callers.
async function getPdfBranding() {
  try {
    return pdfBranding(await getDocumentSettings());
  } catch (_) {
    return pdfBranding(null); // never let a settings read break a PDF
  }
}

module.exports = { getDocumentSettings, getPdfBranding, pdfBranding, invalidate };
