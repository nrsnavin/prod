'use strict';
// ══════════════════════════════════════════════════════════════════
//  RATE-LIMIT COUNTERS THAT EVERY PROCESS SHARES
//
//  express-rate-limit's default MemoryStore keeps its counters inside
//  the process. That was harmless with one process, and it is the one
//  piece of state that stops this API from running as several: four
//  workers means four private counters, so the configured ceiling is
//  quietly multiplied by four and depends on which worker the proxy
//  happens to pick.
//
//  This keeps one counter per key in MongoDB instead:
//
//      { _id: '<prefix><key>', hits: <n>, resetAt: <Date> }
//
//  ── One atomic write per hit ─────────────────────────────────────
//  The increment and the window reset happen in the SAME update, as an
//  aggregation-pipeline upsert. A read-then-write would let two workers
//  both see an expired window and both start a fresh one, dropping a
//  hit; here the document decides for itself, under the server's
//  document lock, whether its window is still open.
//
//  ── Expiry ───────────────────────────────────────────────────────
//  A TTL index on `resetAt` removes finished windows. The TTL monitor
//  runs about once a minute, so a document can outlive its window by
//  that much — which is why the update checks `resetAt` itself rather
//  than trusting that an existing document is a live one.
//
//  ── Fail open ────────────────────────────────────────────────────
//  Rate limiting is defence in depth. If the counter cannot be written
//  — database not connected yet, an election in progress — the request
//  is let through and counted as its first hit, rather than turned
//  into a 500. A limiter that takes the API down with the database has
//  made an outage worse, not safer.
//
//  The raw driver collection is used rather than a mongoose model on
//  purpose: models are routed per user by db/tenants.js, and a counter
//  that followed a sandbox user into the sandbox database would be a
//  second, separate bucket for the same person.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const COLLECTION = 'ratelimits';

class MongoRateLimitStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.prefix]   namespaces one limiter's keys from another's
   * @param {() => any} [opts.connection]  the mongoose connection (tests)
   */
  constructor({ prefix = 'rl:', connection } = {}) {
    this.prefix = prefix;
    // Counters live in the database, so a hit counted by one process is
    // seen by every other. express-rate-limit uses this to tell a real
    // double-count from two limiters sharing a store.
    this.localKeys = false;
    this._connection = connection || (() => mongoose.connection);
    this.windowMs = 60_000;
    this._indexed = null;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  _live() {
    const conn = this._connection();
    return conn && conn.readyState === 1 ? conn : null;
  }

  _collection(conn) {
    const col = conn.collection(COLLECTION);
    // Once per process. A failure is logged and retried on the next
    // hit; a missing TTL index only means finished windows linger.
    if (!this._indexed) {
      this._indexed = col
        .createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 })
        .catch((err) => {
          this._indexed = null;
          console.warn(`[rate-limit] TTL index not created: ${err?.message}`);
        });
    }
    return col;
  }

  _firstHit() {
    return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
  }

  async increment(key) {
    const conn = this._live();
    if (!conn) return this._firstHit();

    const now = new Date();
    const fresh = new Date(now.getTime() + this.windowMs);
    // `$resetAt > now` is false for a missing field (null sorts below any
    // date), so the same expression starts a window on insert and
    // restarts one that has run out.
    const open = { $gt: ['$resetAt', now] };
    try {
      const doc = await this._collection(conn).findOneAndUpdate(
        { _id: this.prefix + key },
        [
          {
            $set: {
              hits: { $cond: [open, { $add: ['$hits', 1] }, 1] },
              resetAt: { $cond: [open, '$resetAt', fresh] },
            },
          },
        ],
        { upsert: true, returnDocument: 'after' }
      );
      // Driver 6 returns the document itself (no { value } envelope).
      if (!doc) return this._firstHit();
      return { totalHits: Number(doc.hits) || 1, resetTime: doc.resetAt };
    } catch (err) {
      console.warn(`[rate-limit] counter unavailable, allowing request: ${err?.message}`);
      return this._firstHit();
    }
  }

  async decrement(key) {
    const conn = this._live();
    if (!conn) return;
    try {
      await this._collection(conn).updateOne(
        { _id: this.prefix + key, hits: { $gt: 0 } },
        { $inc: { hits: -1 } }
      );
    } catch (err) {
      console.warn(`[rate-limit] decrement failed: ${err?.message}`);
    }
  }

  async resetKey(key) {
    const conn = this._live();
    if (!conn) return;
    try {
      await this._collection(conn).deleteOne({ _id: this.prefix + key });
    } catch (err) {
      console.warn(`[rate-limit] reset failed: ${err?.message}`);
    }
  }

  async get(key) {
    const conn = this._live();
    if (!conn) return undefined;
    const doc = await this._collection(conn).findOne({ _id: this.prefix + key });
    if (!doc || !(doc.resetAt > new Date())) return undefined;
    return { totalHits: doc.hits, resetTime: doc.resetAt };
  }
}

module.exports = { MongoRateLimitStore, COLLECTION };
