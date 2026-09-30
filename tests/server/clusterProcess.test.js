'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE REAL THING: index.js AS SEVERAL PROCESSES
//
//  Starts `node index.js` with WEB_CONCURRENCY=2 against an in-memory
//  replica set and checks, from outside, what an operator would check:
//  two workers serve; killing one is survived with no failed request
//  and a replacement appears; SIGTERM drains everything and exits 0
//  with no orphaned workers. And WEB_CONCURRENCY=1 is still one process.
// ══════════════════════════════════════════════════════════════════

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
}, 180_000);
afterAll(async () => { await mongo.stop(); });

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// A new connection per request (agent: false). Node's default agent
// keeps sockets alive, and a pooled socket to a worker that was just
// killed fails on reuse — a client artefact, which browsers and nginx
// absorb by retrying an idle connection that was reset, and not the
// server behaviour this file is measuring.
const get = (port, p) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2000, agent: false }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', () => resolve({ status: 0 }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
});

const childrenOf = (pid) => {
  try {
    return execSync(`pgrep -P ${pid}`).toString().trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; }
};

async function until(check, timeoutMs = 60_000, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function start(concurrency) {
  const port = await freePort();
  const out = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'index.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WEB_CONCURRENCY: String(concurrency),
      PORT: String(port),
      HOST: '127.0.0.1',
      MONGO_URL: mongo.getUri('cluster_probe'),
      JWT_SECRET_KEY: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = await until(async () => (await get(port, '/api/v2/health/ready')).status === 200);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`server never became ready:\n${out.join('')}`);
  }
  return { child, port, exited, out };
}

describe('WEB_CONCURRENCY=2', () => {
  let srv;
  beforeAll(async () => { srv = await start(2); }, 120_000);
  afterAll(async () => {
    if (srv && srv.child.exitCode === null) { srv.child.kill('SIGKILL'); await srv.exited; }
  });

  it('runs a primary with two workers under it', async () => {
    expect(await until(async () => childrenOf(srv.child.pid).length === 2)).toBe(true);
  });

  it('serves while a worker is killed, and replaces it', async () => {
    const before = childrenOf(srv.child.pid);
    process.kill(before[0], 'SIGKILL');

    // A request the worker was in the middle of dies with it — a hard
    // crash loses what that process held. Wait for the primary to have
    // reaped it (which is also when it forks the replacement)...
    expect(await until(async () => !childrenOf(srv.child.pid).includes(before[0]))).toBe(true);

    // ...and from then on nothing fails, including while the
    // replacement is still booting: the surviving worker answers. One
    // crash used to be a full outage until systemd restarted the unit.
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await get(srv.port, '/api/v2/health')).status);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(statuses).toEqual(Array(20).fill(200));

    const replaced = await until(async () => {
      const now = childrenOf(srv.child.pid);
      return now.length === 2 && !now.includes(before[0]);
    });
    expect(replaced).toBe(true);
  }, 90_000);

  it('drains and exits 0 on SIGTERM, leaving no workers behind', async () => {
    const workers = childrenOf(srv.child.pid);
    srv.child.kill('SIGTERM');
    const { code } = await srv.exited;
    expect(code).toBe(0);
    const orphans = workers.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    expect(orphans).toEqual([]);
  }, 60_000);
});

describe('WEB_CONCURRENCY=1', () => {
  it('is the single process it always was — no primary, no children', async () => {
    const srv = await start(1);
    try {
      expect(childrenOf(srv.child.pid)).toEqual([]);
      expect((await get(srv.port, '/api/v2/health')).status).toBe(200);
    } finally {
      srv.child.kill('SIGTERM');
      const { code } = await srv.exited;
      expect(code).toBe(0);
    }
  }, 120_000);
});
