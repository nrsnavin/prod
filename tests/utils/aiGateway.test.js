'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE AI GATEWAY — timeout, concurrency cap and circuit breaker
//
//  Held here, against a stand-in client so nothing leaves the machine:
//    • a call that never answers ends at its budget, as AI_TIMEOUT, and
//      the SDK is handed the timeout, one retry and an abort signal;
//    • a request with an image or PDF gets the vision budget and lane;
//    • at most N calls run at once; the rest wait, and past the queue
//      the caller is told AI is busy at once;
//    • five outage-like failures in a row open the circuit, so the next
//      call fails at once without touching the service; after the open
//      period one trial goes through, and its success closes it;
//    • a 400 (the request's fault) never opens the circuit;
//    • the shared client from utils/anthropicClient.js is the guarded one.
// ══════════════════════════════════════════════════════════════════

const gw = require('../../utils/aiGateway');

const ENV = ['AI_TEXT_TIMEOUT_MS', 'AI_VISION_TIMEOUT_MS', 'AI_TEXT_CONCURRENCY', 'AI_MAX_QUEUE', 'AI_BREAKER_FAILURES', 'AI_BREAKER_OPEN_MS'];
const text = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
const image = {
  model: 'm', max_tokens: 10,
  messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] }],
};

/** A client whose answers the test decides, call by call. */
function stub() {
  const calls = [];
  const client = {
    messages: {
      create: jest.fn((params, opts) => new Promise((resolve, reject) => {
        calls.push({ params, opts, resolve, reject });
      })),
    },
  };
  return { client, calls, guarded: gw.guard(client) };
}
const status = (s) => Object.assign(new Error(`status ${s}`), { status: s });
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  gw._reset();
  process.env.AI_TEXT_TIMEOUT_MS = '200';
  process.env.AI_VISION_TIMEOUT_MS = '400';
  process.env.AI_TEXT_CONCURRENCY = '2';
  process.env.AI_MAX_QUEUE = '1';
  process.env.AI_BREAKER_FAILURES = '3';
  process.env.AI_BREAKER_OPEN_MS = '300';
});
afterAll(() => { for (const k of ENV) delete process.env[k]; gw._reset(); });

describe('timeout', () => {
  it('hands the SDK a timeout, one retry and an abort signal', async () => {
    const { calls, guarded } = stub();
    const p = guarded.messages.create(text);
    await tick();
    expect(calls[0].opts).toMatchObject({ timeout: 200, maxRetries: 1 });
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal);
    calls[0].resolve({ content: [] });
    await expect(p).resolves.toEqual({ content: [] });
  });

  it('ends a call that never answers, and aborts it', async () => {
    const { calls, guarded } = stub();
    const started = Date.now();
    const p = guarded.messages.create(text);
    await expect(p).rejects.toMatchObject({ code: 'AI_TIMEOUT', statusCode: 503 });
    // The budget covers the one retry: 2 × 200 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(calls[0].opts.signal.aborted).toBe(true);
    expect(gw.gatewayState().text.active).toBe(0); // its slot came back
  });

  it('gives a request with an image the vision budget', async () => {
    const { calls, guarded } = stub();
    const p = guarded.messages.create(image);
    await tick();
    expect(calls[0].opts.timeout).toBe(400);
    expect(gw.gatewayState().vision.active).toBe(1);
    calls[0].resolve({});
    await p;
  });
});

describe('concurrency cap', () => {
  it('runs two at once, queues one, and turns the next away at once', async () => {
    const { client, calls, guarded } = stub();
    const a = guarded.messages.create(text);
    const b = guarded.messages.create(text);
    const c = guarded.messages.create(text); // queued
    await tick();
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(gw.gatewayState().text).toEqual({ active: 2, waiting: 1 });

    await expect(guarded.messages.create(text)).rejects.toMatchObject({ code: 'AI_BUSY' });

    calls[0].resolve('a');
    await a;
    await tick();
    expect(client.messages.create).toHaveBeenCalledTimes(3); // c took a's slot
    calls[1].resolve('b');
    calls[2].resolve('c');
    await expect(Promise.all([b, c])).resolves.toEqual(['b', 'c']);
    expect(gw.gatewayState().text).toEqual({ active: 0, waiting: 0 });
  });

  it('frees the slot when a call fails', async () => {
    const { calls, guarded } = stub();
    const p = guarded.messages.create(text);
    await tick();
    calls[0].reject(status(400));
    await expect(p).rejects.toThrow('status 400');
    expect(gw.gatewayState().text.active).toBe(0);
  });
});

describe('circuit breaker', () => {
  async function failWith(guarded, calls, err) {
    const p = guarded.messages.create(text);
    await tick();
    calls.at(-1).reject(err);
    await expect(p).rejects.toBe(err);
  }

  it('opens after three outage failures and then fails at once', async () => {
    const { client, calls, guarded } = stub();
    await failWith(guarded, calls, status(500));
    await failWith(guarded, calls, status(529));
    await failWith(guarded, calls, Object.assign(new Error('socket hang up'), {}));
    expect(gw.gatewayState().breaker).toBe('open');

    await expect(guarded.messages.create(text)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', statusCode: 503 });
    expect(client.messages.create).toHaveBeenCalledTimes(3); // the service was not asked
  });

  it('lets one trial through after the open period, and closes on success', async () => {
    const { calls, guarded } = stub();
    for (let i = 0; i < 3; i++) await failWith(guarded, calls, status(503));
    await new Promise((r) => setTimeout(r, 320));
    expect(gw.gatewayState().breaker).toBe('half-open');

    const trial = guarded.messages.create(text);
    await tick();
    // A second caller during the trial still fails fast.
    await expect(guarded.messages.create(text)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    calls.at(-1).resolve('ok');
    await expect(trial).resolves.toBe('ok');
    expect(gw.gatewayState().breaker).toBe('closed');
  });

  it('opens again at once when the trial fails', async () => {
    const { calls, guarded } = stub();
    for (let i = 0; i < 3; i++) await failWith(guarded, calls, status(503));
    await new Promise((r) => setTimeout(r, 320));
    await failWith(guarded, calls, status(503));
    expect(gw.gatewayState().breaker).toBe('open');
  });

  it('is not opened by bad requests, and an answer ends a run of failures', async () => {
    const { calls, guarded } = stub();
    for (let i = 0; i < 5; i++) await failWith(guarded, calls, status(400));
    expect(gw.gatewayState().breaker).toBe('closed');

    await failWith(guarded, calls, status(500));
    await failWith(guarded, calls, status(500));
    await failWith(guarded, calls, status(400)); // the service answered
    await failWith(guarded, calls, status(500));
    expect(gw.gatewayState()).toMatchObject({ breaker: 'closed', consecutiveFailures: 1 });
  });

  it('counts a timeout as an outage', async () => {
    const { guarded } = stub();
    for (let i = 0; i < 3; i++) {
      await expect(guarded.messages.create(text)).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    }
    expect(gw.gatewayState().breaker).toBe('open');
  }, 10_000);
});

describe('the shared client', () => {
  it('is the guarded one', () => {
    jest.isolateModules(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const { anthropic } = require('../../utils/anthropicClient');
      const c = anthropic();
      expect(Object.keys(c)).toEqual(['messages']);
      expect(Object.keys(c.messages)).toEqual(['create']);
      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  it('tells vision from text and outages from bad requests', () => {
    expect(gw.isVision(image)).toBe(true);
    expect(gw.isVision(text)).toBe(false);
    expect(gw.isOutage(status(429))).toBe(true);
    expect(gw.isOutage(status(502))).toBe(true);
    expect(gw.isOutage(status(401))).toBe(false);
    expect(gw.isOutage(new Error('ECONNRESET'))).toBe(true);
  });
});
