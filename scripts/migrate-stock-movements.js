#!/usr/bin/env node
// scripts/migrate-stock-movements.js
// ─────────────────────────────────────────────────────────────
//  One-shot migration: copy embedded Elastic.stockMovements into
//  the standalone StockMovement collection, backfill
//  Elastic.quantityProduced from PACKING_INWARD history, and
//  report per-elastic drift between stored stock and ledger sum.
//
//  Idempotent and resumable:
//   • Per-elastic insert uses { ordered: false }, so we tolerate
//     duplicate-key errors from rows that were inserted by a
//     previous (possibly crashed) run.
//   • Drift / quantityProduced are recomputed from the embedded
//     source data every run, so they're always correct on retry.
//
//  Run from the repo root once MONGO_URI (or DB_URL) is set:
//    node scripts/migrate-stock-movements.js
// ─────────────────────────────────────────────────────────────
"use strict";

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const mongoose      = require("mongoose");
const Elastic       = require("../models/Elastic");
const StockMovement = require("../models/StockMovement");

async function main() {
  const uri = process.env.MONGO_URI || process.env.DB_URL || process.env.MONGO_URL;
  if (!uri) {
    console.error("MONGO_URI / DB_URL / MONGO_URL not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected.");

  const elastics = await Elastic
    .find({}, { name: 1, stock: 1, stockMovements: 1 })
    .lean();
  console.log(`Scanning ${elastics.length} elastics.`);

  let migrated   = 0;
  let resumed    = 0;
  let skipped    = 0;
  let totalNew   = 0;
  let totalDup   = 0;
  const drifts   = [];

  for (const e of elastics) {
    const rows = (e.stockMovements || [])
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (rows.length === 0) {
      skipped++;
      continue;
    }

    const existing = await StockMovement.countDocuments({ elastic: e._id });
    const isResume = existing > 0 && existing < rows.length;

    const docs = rows.map((m) => ({
      _id:       m._id,
      elastic:   e._id,
      date:      m.date,
      type:      m.type,
      requested: Number(m.quantity) || 0,
      applied:   Number(m.quantity) || 0,
      balance:   Number(m.balance)  || 0,
      refType:   m.refType,
      refId:     m.refId,
      reason:    m.reason,
      by:        m.by,
    }));

    let insertedCount = 0;
    let duplicateCount = 0;

    try {
      const res = await StockMovement.insertMany(docs, {
        ordered: false,
        rawResult: true,
      });
      // rawResult shape: { acknowledged, insertedCount, insertedIds }
      insertedCount = res.insertedCount || 0;
    } catch (err) {
      // BulkWriteError: some rows duplicate-keyed (already migrated
      // by a previous run). Mongo still inserts the rest.
      const writeErrors = (err && err.writeErrors) || [];
      duplicateCount = writeErrors.filter((w) => w.code === 11000).length;
      const nonDup = writeErrors.filter((w) => w.code !== 11000);
      if (nonDup.length > 0) {
        console.error(
          `  [${e.name}] aborting — non-duplicate write errors:`,
          nonDup.map((w) => w.errmsg)
        );
        throw err;
      }
      // BulkWriteError reports insertedCount on err.result.nInserted
      insertedCount = (err.result && err.result.nInserted) || 0;
    }

    if (insertedCount > 0) {
      totalNew += insertedCount;
      if (isResume) {
        resumed++;
      } else {
        migrated++;
      }
    } else {
      // All docs were duplicates of an already-migrated set.
      skipped++;
    }
    totalDup += duplicateCount;

    if (duplicateCount > 0) {
      console.log(
        `  [${e.name}] inserted ${insertedCount} new, skipped ${duplicateCount} already-migrated rows.`
      );
    }

    // Always recompute quantityProduced and drift from the embedded
    // source (idempotent — same result every run).
    const produced = rows
      .filter((r) => r.type === "PACKING_INWARD")
      .reduce((s, r) => s + (Number(r.quantity) || 0), 0);

    await Elastic.updateOne(
      { _id: e._id },
      { $set: { quantityProduced: Math.max(0, produced) } }
    );

    const ledgerSum = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const drift     = (Number(e.stock) || 0) - ledgerSum;
    if (drift !== 0) {
      drifts.push({
        id:        e._id,
        name:      e.name,
        stock:     Number(e.stock) || 0,
        ledgerSum,
        drift,
      });
    }
  }

  console.log(
    `\nMigrated ${migrated} elastics (+${resumed} resumed). Skipped ${skipped}.`
  );
  console.log(`Inserted ${totalNew} new rows, tolerated ${totalDup} duplicates.`);

  if (drifts.length > 0) {
    console.log("\nElastics with stock vs ledger drift:");
    for (const d of drifts) {
      console.log(
        `  ${d.name} (${d.id}): stock=${d.stock} ledgerSum=${d.ledgerSum} drift=${d.drift}`
      );
    }
    console.log(
      "\nReview each drift and reconcile via a MANUAL_ADJUST in the admin UI."
    );
  } else {
    console.log("\nNo drift detected.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
