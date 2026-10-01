'use strict';

// ══════════════════════════════════════════════════════════════════
//  THE AI GATEWAY — every Claude call goes through here
//
//  Twelve features call Claude: briefings, the assistant, OCR of shift
//  sheets and purchase orders, QC photos, root-cause notes. Each used
//  the raw SDK client, and so each inherited its defaults: a ten-minute
//  timeout and two retries. One slow or stuck call could hold a request
//  — and the connection, memory and database session behind it — for
//  half an hour, and when the service was down every request still
//  waited for it to fail.
//
//  `guard(client)` returns an object with the same `messages.create`
//  the call sites already use, wrapped in three protections:
//
//    • Timeout. 30 s for text, 90 s for a request carrying an image or
//      a PDF, and one retry, not two. The SDK's own timeout is set AND
//      an abort signal fires, so a call cannot outlive its budget.
//
//    • Concurrency cap (bulkhead). At most 4 text and 2 vision calls at
//      once per process; up to 20 more wait their turn, for at most the
//      timeout. Past that the caller is told at once that AI is busy,
//      rather than ten OCR uploads exhausting memory together.
//
//    • Circuit breaker. After 5 failures in a row that look like the
//      service is in trouble (timeouts, network errors, 429 and 5xx),
//      calls fail at once for 60 s. Then one call is let through; if it
//      succeeds the circuit closes. A 400 from a malformed request is
//      the caller's bug, not an outage, and does not count.
//
//  Every refusal is an ErrorHandler with status 503 and a string `code`
//  (AI_UNAVAILABLE, AI_BUSY, AI_TIMEOUT), so a route that lets it
//  through answers 503 with a plain message, and the text features —
//  which already catch and fall back to a template — simply fall back
//  sooner.
//
//  Per process, like the rest of the app's runtime state: each cluster
//  worker keeps its own breaker and its own queue. That is deliberate;
//  a breaker per worker trips a little later, but needs nothing shared.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('./ErrorHandler');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const config = () => ({
  textTimeoutMs:    num('AI_TEXT_TIMEOUT_MS', 30_000),
  visionTimeoutMs:  num('AI_VISION_TIMEOUT_MS', 90_000),
  maxRetries:       1,
  textConcurrency:  num('AI_TEXT_CONCURRENCY', 4),
  visionConcurrency: num('AI_VISION_CONCURRENCY', 2),
  maxQueue:         num('AI_MAX_QUEUE', 20),
  failureThreshold: num('AI_BREAKER_FAILURES', 5),
  openMs:           num('AI_BREAKER_OPEN_MS', 60_000),
});

function aiError(code, message) {
  const err = new ErrorHandler(message, 503);
  err.code = code;
  return err;
}

/** True when the request carries an image or a document (a vision call). */
function isVision(params) {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  return messages.some((m) =>
    Array.isArray(m?.content) && m.content.some((c) => c?.type === 'image' || c?.type === 'document')
  );
}

/**
 * Does this failure say the SERVICE is in trouble? Timeouts, dropped
 * connections, rate limits and 5xx do. A 4xx other than 429 says the
 * request was wrong, and the next one may be fine.
 */
function isOutage(err) {
  if (!err) return false;
  if (err.code === 'AI_TIMEOUT') return true;
  const status = Number(err.status ?? err.statusCode);
  if (Number.isFinite(status) && status > 0) return status === 429 || status >= 500;
  return true; // no status at all: a network failure
}

// ── Concurrency cap ────────────────────────────────────────────────
class Lane {
  constructor(name) {
    this.name = name;
    this.active = 0;
    this.waiting = [];
  }

  /** Resolves with a release function once a slot is free. */
  acquire(limit, maxQueue, waitMs) {
    if (this.active < limit) {
      this.active++;
      return Promise.resolve(this._release());
    }
    if (this.waiting.length >= maxQueue) {
      return Promise.reject(aiError('AI_BUSY', 'AI is busy right now. Try again in a minute.'));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.waiting = this.waiting.filter((e) => e !== entry);
        reject(aiError('AI_BUSY', 'AI is busy right now. Try again in a minute.'));
      }, waitMs);
      entry.timer.unref?.();
      this.waiting.push(entry);
    });
  }

  _release() {
    let done = false;
    return () => {
      if (done) return; // releasing twice must not free two slots
      done = true;
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this._release()); // the slot passes straight on
      } else {
        this.active--;
      }
    };
  }
}

// ── Circuit breaker ────────────────────────────────────────────────
class Breaker {
  constructor() {
    this.failures = 0;
    this.openUntil = 0;
    this.trial = false; // a half-open trial call is in flight
  }

  get state() {
    if (this.openUntil === 0) return 'closed';
    return Date.now() < this.openUntil ? 'open' : 'half-open';
  }

  /** Throws when calls should fail fast; otherwise lets this one through. */
  admit() {
    const s = this.state;
    if (s === 'open') {
      throw aiError('AI_UNAVAILABLE', 'AI is unavailable right now. Everything else still works; try again in a minute.');
    }
    if (s === 'half-open') {
      if (this.trial) {
        throw aiError('AI_UNAVAILABLE', 'AI is unavailable right now. Everything else still works; try again in a minute.');
      }
      this.trial = true;
    }
  }

  success() {
    this.failures = 0;
    this.openUntil = 0;
    this.trial = false;
  }

  failure(outage, { failureThreshold, openMs }) {
    const wasTrial = this.trial;
    this.trial = false;
    if (!outage) {
      // The service answered; the request was the problem. An answer
      // is proof the service is up, so the run of failures ends here.
      this.success();
      return;
    }
    this.failures++;
    if (wasTrial || this.failures >= failureThreshold) {
      this.openUntil = Date.now() + openMs;
      console.warn(`[ai] circuit open for ${Math.round(openMs / 1000)} s after ${this.failures} failures`);
    }
  }
}

const lanes = { text: new Lane('text'), vision: new Lane('vision') };
const breaker = new Breaker();

async function call(client, params, options = {}) {
  const cfg = config();
  breaker.admit();

  const vision = isVision(params);
  const lane = vision ? lanes.vision : lanes.text;
  const timeoutMs = vision ? cfg.visionTimeoutMs : cfg.textTimeoutMs;
  let release;
  try {
    release = await lane.acquire(vision ? cfg.visionConcurrency : cfg.textConcurrency, cfg.maxQueue, timeoutMs);
  } catch (err) {
    // A full queue is our limit, not the service failing: give a
    // half-open trial back so the next caller can make it.
    breaker.trial = false;
    throw err;
  }

  // Covers the SDK's own retry too, so the budget is for the whole call.
  const budget = timeoutMs * (cfg.maxRetries + 1);
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(aiError('AI_TIMEOUT', 'AI took too long to answer. Try again in a minute.'));
    }, budget);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([
      client.messages.create(params, {
        ...options,
        timeout: timeoutMs,
        maxRetries: cfg.maxRetries,
        signal: controller.signal,
      }),
      timedOut,
    ]);
    breaker.success();
    return result;
  } catch (err) {
    breaker.failure(isOutage(err), cfg);
    throw err;
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** The SDK client, with every `messages.create` guarded. */
function guard(client) {
  return {
    messages: {
      create: (params, options) => call(client, params, options),
    },
  };
}

/** For /health/ai and the tests. */
function gatewayState() {
  return {
    breaker: breaker.state,
    consecutiveFailures: breaker.failures,
    text:   { active: lanes.text.active,   waiting: lanes.text.waiting.length },
    vision: { active: lanes.vision.active, waiting: lanes.vision.waiting.length },
  };
}

/** Tests only: back to a closed breaker and empty lanes. */
function _reset() {
  breaker.success();
  for (const l of Object.values(lanes)) {
    for (const w of l.waiting) clearTimeout(w.timer);
    l.waiting = [];
    l.active = 0;
  }
}

module.exports = { guard, gatewayState, isVision, isOutage, _reset };
