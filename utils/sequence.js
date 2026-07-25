'use strict';
// Race-free document-number allocation.
//
// The old pattern — findOne().sort({no:-1}) then +1 — reads the max and
// writes the increment in two separate steps, so two concurrent creates
// could both read 1042 and both write 1043 (duplicate PO numbers, or a
// unique-index error on DC numbers). This module replaces it with a
// single atomic $inc on a Counter doc.
//
// Seeding: the first allocation for a sequence initialises the counter
// from `seedFrom()` (typically the current max in the collection) using
// $max, which is idempotent — two concurrent first-callers both seed,
// then both $inc, and still receive distinct numbers.

const Counter = require("../models/Counter.js");

/**
 * Allocate the next number for `key`.
 *
 * @param {string} key        counter id, e.g. "poNo" or "dc:elastic:25/26"
 * @param {() => Promise<number>} seedFrom
 *        called once, on first use, to find the current max already in
 *        the data (return 0/null when none). The first allocated number
 *        is seed + 1.
 */
async function nextNumber(key, seedFrom) {
  let doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true }
  );
  if (doc) return doc.seq;

  // First use — seed from existing data, idempotently ($max), then inc.
  const seed = Math.max(0, Number(await seedFrom()) || 0);
  try {
    // _id comes from the filter on insert; $max seeds without clobbering
    // a value another racer may have just written.
    await Counter.updateOne(
      { _id: key },
      { $max: { seq: seed } },
      { upsert: true }
    );
  } catch (err) {
    // Two concurrent first-callers can both take the insert path. A
    // duplicate on OUR key is harmless (the doc now exists and the $inc
    // below still hands out distinct numbers) — but a duplicate on any
    // other index means the seed did NOT land, and continuing would read
    // `seq` off null. Re-check before deciding it was benign.
    if (err?.code !== 11000) throw err;
    const exists = await Counter.exists({ _id: key });
    if (!exists) {
      throw new Error(
        `Could not seed counter "${key}" — a duplicate-key error left it uncreated. ` +
        `This usually means another index on the counters collection rejected the row.`
      );
    }
  }
  // upsert so the row is created even if the seeding write above was lost;
  // without it a missing doc returns null and throws on `.seq`.
  doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  if (!doc) throw new Error(`Counter "${key}" could not be allocated`);
  return doc.seq;
}

module.exports = { nextNumber };
