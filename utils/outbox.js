'use strict';
// Transactional outbox — write side + dispatcher.
//
//   enqueue(session, kind, payload)
//     Called INSIDE a business transaction. The event commits or rolls
//     back with the business write, so delivery and commit can't diverge.
//
//   processDueEvents()
//     One dispatcher pass: claim due pending events one at a time
//     (atomic pending→processing flip, so multiple processes can't
//     double-deliver), run the kind's handler, mark sent / reschedule
//     with exponential backoff / park as failed after MAX_ATTEMPTS.
//     Exported directly so tests drive it without timers.
//
//   startOutboxDispatcher()
//     setInterval wrapper used by index.js. In-process is deliberate —
//     one node, one plant; a queue broker would be gold-plating.

const Outbox = require("../models/Outbox.js");
const { getHandler } = require("./outboxHandlers.js");

const MAX_ATTEMPTS   = 8;
const BASE_BACKOFF_MS = 30_000;          // 30s, 60s, 2m, 4m, … capped 1h
const MAX_BACKOFF_MS  = 60 * 60 * 1000;
const BATCH_PER_TICK  = 20;

async function enqueue(session, kind, payload) {
  const [doc] = await Outbox.create(
    [{ kind, payload: payload || {} }],
    session ? { session } : {}
  );
  return doc;
}

function backoffMs(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function processDueEvents(now = new Date()) {
  const results = { sent: 0, retried: 0, failed: 0 };

  for (let i = 0; i < BATCH_PER_TICK; i += 1) {
    // Atomic claim — a concurrent dispatcher pass can't grab the same event.
    const event = await Outbox.findOneAndUpdate(
      { status: "pending", nextAttemptAt: { $lte: now } },
      { $set: { status: "processing" }, $inc: { attempts: 1 } },
      { new: true, sort: { nextAttemptAt: 1 } }
    );
    if (!event) break;

    try {
      const handler = getHandler(event.kind);
      if (!handler) throw new Error(`No handler registered for kind "${event.kind}"`);
      await handler(event.payload || {});
      await Outbox.updateOne(
        { _id: event._id },
        { $set: { status: "sent", sentAt: new Date(), lastError: "" } }
      );
      results.sent += 1;
    } catch (err) {
      const exhausted = event.attempts >= MAX_ATTEMPTS;
      await Outbox.updateOne(
        { _id: event._id },
        { $set: {
            status:        exhausted ? "failed" : "pending",
            nextAttemptAt: new Date(now.getTime() + backoffMs(event.attempts)),
            lastError:     String(err?.message || err).slice(0, 500),
          } }
      );
      if (exhausted) {
        results.failed += 1;
        console.error(`[outbox] event ${event._id} (${event.kind}) failed permanently: ${err?.message}`);
      } else {
        results.retried += 1;
      }
    }
  }

  return results;
}

let _timer = null;

function startOutboxDispatcher({ intervalMs = 15_000 } = {}) {
  if (_timer) return _timer;
  _timer = setInterval(() => {
    processDueEvents().catch((err) =>
      console.error("[outbox] dispatcher pass crashed:", err?.message)
    );
  }, intervalMs);
  _timer.unref?.(); // never keep the process alive just for the loop
  console.log(`[outbox] dispatcher started (every ${intervalMs / 1000}s)`);
  return _timer;
}

function stopOutboxDispatcher() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = {
  enqueue,
  processDueEvents,
  startOutboxDispatcher,
  stopOutboxDispatcher,
  MAX_ATTEMPTS,
};
