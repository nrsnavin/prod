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
const { currentDb } = require("../db/tenants");

// One entry per database: with sandbox routing on (db/tenants.js), the
// sandbox and live company profiles are different documents, and a
// single cache would show one's letterhead on the other's PDFs.
const _cache = new Map(); // dbName -> { doc, checkedAt }
const TTL_MS = 60 * 1000; // 60s — settings change rarely

// invalidate() only reaches the process that saved. In cluster mode
// the other workers would keep printing the old letterhead for up to
// the TTL, so past this age a cached copy is checked against the
// stored updatedAt (an indexed read of one small field, not the logo).
const CHECK_AFTER_MS = 5 * 1000;

const _key = () => currentDb() ?? "";
// Milliseconds, not String(date): that drops them, and two saves in one
// second would look the same.
const _time = (d) => (d ? new Date(d).getTime() : null);

// Fetch-or-create the singleton. Never returns null.
async function getDocumentSettings({ fresh = false } = {}) {
  const key = _key();
  const hit = _cache.get(key);
  if (!fresh && hit) {
    const age = Date.now() - hit.checkedAt;
    if (age < CHECK_AFTER_MS) return hit.doc;
    if (age < TTL_MS) {
      const stored = await DocumentSettings.findOne({ key: "document" })
        .select("updatedAt")
        .lean();
      if (stored && _time(stored.updatedAt) === _time(hit.doc.updatedAt)) {
        hit.checkedAt = Date.now();
        return hit.doc;
      }
    }
  }

  // A plain read first: the upsert below stamps updatedAt even when it
  // only reads, which every other worker would take for a fresh save.
  // upsert guarantees exactly one row (unique key:"document").
  const doc =
    (await DocumentSettings.findOne({ key: "document" }).lean()) ||
    (await DocumentSettings.findOneAndUpdate(
      { key: "document" },
      { $setOnInsert: { key: "document" } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean());

  _cache.set(key, { doc, checkedAt: Date.now() });
  return doc;
}

function invalidate() {
  _cache.clear();
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
