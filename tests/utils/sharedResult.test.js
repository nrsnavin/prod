'use strict';
const { sharedResult, forgetShared, MAX_KEYS } = require('../../utils/sharedResult');

afterEach(() => forgetShared());

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('sharedResult', () => {
  it('computes once for callers who arrive together', async () => {
    // Twenty dashboards polling in the same instant are one aggregation.
    let calls = 0;
    const gate = deferred();
    const compute = () => { calls += 1; return gate.promise; };
    const all = Array.from({ length: 20 }, () => sharedResult('k', 5000, compute));
    gate.resolve('answer');
    expect(await Promise.all(all)).toEqual(Array(20).fill('answer'));
    expect(calls).toBe(1);
  });

  it('reuses a recent answer', async () => {
    let calls = 0;
    const compute = async () => ++calls;
    expect(await sharedResult('k', 5000, compute)).toBe(1);
    expect(await sharedResult('k', 5000, compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it('recomputes once the answer is older than the TTL', async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await sharedResult('k', 20, compute);
    await new Promise((r) => setTimeout(r, 40));
    expect(await sharedResult('k', 20, compute)).toBe(2);
  });

  it('never keeps a failure', async () => {
    // A transient database error must not be served to everyone for the
    // next five seconds.
    let calls = 0;
    const compute = async () => { calls += 1; if (calls === 1) throw new Error('blip'); return 'ok'; };
    await expect(sharedResult('k', 5000, compute)).rejects.toThrow('blip');
    expect(await sharedResult('k', 5000, compute)).toBe('ok');
  });

  it('shares a failure with the callers who were already waiting on it', async () => {
    const gate = deferred();
    const a = sharedResult('k', 5000, () => gate.promise);
    const b = sharedResult('k', 5000, () => gate.promise);
    gate.reject(new Error('down'));
    await expect(a).rejects.toThrow('down');
    await expect(b).rejects.toThrow('down');
  });

  it('keeps different keys apart', async () => {
    // The dashboard key carries the tenant database: a sandbox session
    // must never be handed production's numbers.
    expect(await sharedResult('dashboard:kpis:primary', 5000, async () => 'live')).toBe('live');
    expect(await sharedResult('dashboard:kpis:test', 5000, async () => 'sandbox')).toBe('sandbox');
  });

  it('holds a bounded number of keys', async () => {
    for (let i = 0; i < MAX_KEYS + 50; i++) await sharedResult(`k${i}`, 60_000, async () => i);
    // The oldest were evicted, so asking again recomputes.
    let recomputed = false;
    await sharedResult('k0', 60_000, async () => { recomputed = true; return 0; });
    expect(recomputed).toBe(true);
  });
});
