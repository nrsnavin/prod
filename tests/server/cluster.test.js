'use strict';
// The primary's policy, with a stand-in for node:cluster so that
// "a worker died", "a worker keeps dying" and "SIGTERM arrived" can be
// played out deterministically. The real processes are exercised in
// clusterProcess.test.js.

const { EventEmitter } = require('node:events');
const { workerCount, runPrimary } = require('../../server/cluster');

describe('how many workers', () => {
  it('uses WEB_CONCURRENCY when it is set', () => {
    expect(workerCount({ WEB_CONCURRENCY: '3' }, 8)).toBe(3);
  });

  it('is one process when WEB_CONCURRENCY=1 — the rollback', () => {
    expect(workerCount({ WEB_CONCURRENCY: '1', NODE_ENV: 'PRODUCTION' }, 8)).toBe(1);
  });

  it('defaults to one per core, at most four, in production', () => {
    expect(workerCount({ NODE_ENV: 'PRODUCTION' }, 2)).toBe(2);
    expect(workerCount({ NODE_ENV: 'PRODUCTION' }, 16)).toBe(4);
  });

  it('defaults to a single process anywhere else', () => {
    expect(workerCount({ NODE_ENV: 'development' }, 16)).toBe(1);
    expect(workerCount({}, 16)).toBe(1);
  });

  it('falls back to one process on a value it cannot use', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(workerCount({ WEB_CONCURRENCY: 'lots' }, 8)).toBe(1);
    expect(workerCount({ WEB_CONCURRENCY: '0' }, 8)).toBe(1);
    expect(workerCount({ WEB_CONCURRENCY: '-2' }, 8)).toBe(1);
    warn.mockRestore();
  });
});

// ── A fake cluster: fork() makes a worker; exits are played by hand ──
function fakeWorld() {
  const cluster = new EventEmitter();
  cluster.workers = {};
  let next = 1;
  cluster.fork = jest.fn(() => {
    const id = next++;
    const w = {
      id,
      process: {
        pid: 1000 + id,
        kill: jest.fn((sig) => {
          // A worker told to stop drains and exits.
          if (sig === 'SIGTERM') setImmediate(() => die(w, 0));
        }),
      },
    };
    cluster.workers[id] = w;
    return w;
  });
  const die = (w, code = 1, signal = null) => {
    delete cluster.workers[w.id];
    cluster.emit('exit', w, code, signal);
  };
  const proc = new EventEmitter();
  proc.pid = 999;
  proc.exit = jest.fn();
  const log = { log: jest.fn(), error: jest.fn() };
  return { cluster, proc, die, log };
}

describe('the primary', () => {
  it('starts the number of workers it was asked for', () => {
    const w = fakeWorld();
    runPrimary({ workers: 3, cluster: w.cluster, proc: w.proc, log: w.log });
    expect(w.cluster.fork).toHaveBeenCalledTimes(3);
  });

  it('replaces a worker that dies', () => {
    const w = fakeWorld();
    runPrimary({ workers: 2, cluster: w.cluster, proc: w.proc, log: w.log });
    w.die(w.cluster.workers[1], 1);
    expect(w.cluster.fork).toHaveBeenCalledTimes(3);
    expect(Object.keys(w.cluster.workers)).toHaveLength(2);
    expect(w.proc.exit).not.toHaveBeenCalled();
  });

  it('gives up with a failure when workers keep dying, so systemd sees it', async () => {
    const w = fakeWorld();
    runPrimary({ workers: 1, cluster: w.cluster, proc: w.proc, log: w.log, maxRestarts: 3, windowMs: 60_000 });
    for (let i = 0; i < 4; i++) w.die(Object.values(w.cluster.workers)[0], 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(w.proc.exit).toHaveBeenCalledWith(1);
  });

  it('does not count restarts that fell out of the window', () => {
    const w = fakeWorld();
    const { restarts } = runPrimary({ workers: 1, cluster: w.cluster, proc: w.proc, log: w.log, maxRestarts: 2, windowMs: 60_000 });
    restarts.push(Date.now() - 120_000, Date.now() - 90_000); // two old ones
    w.die(Object.values(w.cluster.workers)[0], 1);
    expect(w.proc.exit).not.toHaveBeenCalled();
    expect(restarts).toHaveLength(1);
  });

  it('passes SIGTERM to every worker and exits cleanly once they have drained', async () => {
    const w = fakeWorld();
    runPrimary({ workers: 3, cluster: w.cluster, proc: w.proc, log: w.log });
    const workers = Object.values(w.cluster.workers);
    w.proc.emit('SIGTERM');
    for (const wk of workers) expect(wk.process.kill).toHaveBeenCalledWith('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(w.proc.exit).toHaveBeenCalledWith(0);
    // And nothing was restarted on the way down.
    expect(w.cluster.fork).toHaveBeenCalledTimes(3);
  });

  it('forces the exit if a worker will not drain in time', async () => {
    const w = fakeWorld();
    runPrimary({ workers: 1, cluster: w.cluster, proc: w.proc, log: w.log, shutdownTimeoutMs: 30 });
    Object.values(w.cluster.workers)[0].process.kill = jest.fn(); // ignores SIGTERM
    w.proc.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 60));
    expect(w.proc.exit).toHaveBeenCalledWith(0);
  });
});
