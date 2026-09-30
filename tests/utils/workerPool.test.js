'use strict';
// The worker pool is the thing every CPU-bound job now trusts to keep
// the request thread free, so what is held here is its failure
// behaviour as much as its happy path: a job that throws, a worker that
// dies, a job that never finishes — each must fail THAT job only and
// leave the pool serving the next one.

const { runJob, closePool, poolStats, POOL_SIZE } = require('../../utils/workerPool');

afterAll(() => closePool());

describe('the worker pool', () => {
  it('runs the job on a worker thread, not the main one', async () => {
    const r = await runJob('pool.selfTest', ['echo', 42]);
    expect(r.isMainThread).toBe(false);
    expect(r.threadId).toBeGreaterThan(0);
    expect(r.value).toBe(42);
  });

  it('hands a Buffer back as a Buffer', async () => {
    // Structured clone turns it into a bare Uint8Array. The PDF routes
    // res.send() the result, which treats the two differently.
    const b = await runJob('pool.selfTest', ['bytes', 'hello']);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(b.toString()).toBe('hello');
  });

  it('carries a job\'s own error message and code back', async () => {
    await expect(runJob('pool.selfTest', ['throw', 'bad input'])).rejects.toMatchObject({
      message: 'bad input',
      code: 'SELF_TEST',
    });
  });

  it('refuses a job name it does not know', async () => {
    await expect(runJob('no.such.job')).rejects.toMatchObject({ code: 'UNKNOWN_JOB' });
  });

  it('fails only the job whose worker died, and keeps serving', async () => {
    await expect(runJob('pool.selfTest', ['crash'])).rejects.toThrow(/exited/);
    const r = await runJob('pool.selfTest', ['echo', 'after']);
    expect(r.value).toBe('after');
  });

  it('stops a job that runs past its timeout, and keeps serving', async () => {
    await expect(runJob('pool.selfTest', ['spin', 2000], { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'WORKER_TIMEOUT',
    });
    const r = await runJob('pool.selfTest', ['echo', 'still here']);
    expect(r.value).toBe('still here');
  });

  it('queues more jobs than it has workers and finishes all of them', async () => {
    const n = POOL_SIZE * 4 + 1;
    const out = await Promise.all(
      Array.from({ length: n }, (_, i) => runJob('pool.selfTest', ['echo', i]))
    );
    expect(out.map((o) => o.value)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(poolStats().live).toBeLessThanOrEqual(POOL_SIZE);
    expect(poolStats().queued).toBe(0);
  });

  it('keeps the request thread free while a job computes', async () => {
    // The whole point. A 300 ms spin on a worker must not delay a timer
    // on the main thread by anything like 300 ms.
    let last = Date.now(), worst = 0;
    const iv = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 5);
    await runJob('pool.selfTest', ['spin', 300]);
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(iv);
    expect(worst).toBeLessThan(150);
  });
});
