'use strict';
// ══════════════════════════════════════════════════════════════════
//  PASSWORD HASHING
//
//  bcryptjs chains its "async" work through process.nextTick, so twenty
//  concurrent logins measured as a single 1.6 s stall of the thread
//  that serves every request. The last describe block below is the
//  point of the change: a login burst — new hashes AND legacy ones —
//  must leave that thread free.
// ══════════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const { hashPassword, verifyPassword, dummyHash, isLegacyHash } = require('../../utils/passwordHash');
const { closePool } = require('../../utils/workerPool');

afterAll(() => closePool());

/** Longest gap between 2 ms ticks while `work` runs: how long the thread was stuck. */
async function longestStall(work) {
  let last = Date.now(), worst = 0;
  const iv = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 2);
  await work();
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(iv);
  return worst;
}

describe('new hashes', () => {
  it('are scrypt, with their parameters written in', async () => {
    const h = await hashPassword('pass1234');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('verify the right password', async () => {
    const h = await hashPassword('pass1234');
    expect(await verifyPassword('pass1234', h)).toEqual({ ok: true, needsRehash: false });
  });

  it('refuse the wrong one', async () => {
    const h = await hashPassword('pass1234');
    expect((await verifyPassword('pass1235', h)).ok).toBe(false);
  });

  it('are salted — the same password never hashes the same way twice', async () => {
    expect(await hashPassword('pass1234')).not.toBe(await hashPassword('pass1234'));
  });

  it('refuse to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});

describe('legacy bcrypt hashes', () => {
  it('still verify, and ask to be upgraded', async () => {
    const legacy = bcrypt.hashSync('pass1234', 4);
    expect(isLegacyHash(legacy)).toBe(true);
    expect(await verifyPassword('pass1234', legacy)).toEqual({ ok: true, needsRehash: true });
  });

  it('never ask to be upgraded on a wrong password', async () => {
    // An upgrade writes a new hash of what was typed. Doing that on a
    // guess would replace the user's password with the guess.
    const legacy = bcrypt.hashSync('pass1234', 4);
    expect(await verifyPassword('wrong', legacy)).toEqual({ ok: false, needsRehash: false });
  });
});

describe('hashes from an older, weaker setting', () => {
  it('verify, and ask to be upgraded', async () => {
    // Built by hand at N=2^10 to stand in for a future raise of the
    // parameters: every account must upgrade itself at its next login.
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync('pass1234', salt, 64, { N: 1024, r: 8, p: 1 });
    const weak = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    expect(await verifyPassword('pass1234', weak)).toEqual({ ok: true, needsRehash: true });
  });
});

describe('anything else', () => {
  it.each([
    ['plain text stored', 'pass1234'],
    ['a truncated scrypt record', 'scrypt$16384$8$1$abc'],
    ['a non-power-of-two cost', 'scrypt$1000$8$1$YWJj$YWJj'],
    ['an empty hash', ''],
  ])('refuses %s without throwing', async (_label, stored) => {
    expect(await verifyPassword('pass1234', stored)).toEqual({ ok: false, needsRehash: false });
  });

  it('refuses a non-string password', async () => {
    const h = await hashPassword('pass1234');
    expect((await verifyPassword(undefined, h)).ok).toBe(false);
    expect((await verifyPassword({ $ne: null }, h)).ok).toBe(false);
  });

  it('has a dummy hash nothing matches', async () => {
    const d = await dummyHash();
    expect((await verifyPassword('pass1234', d)).ok).toBe(false);
    expect((await verifyPassword('', d)).ok).toBe(false);
  });
});

describe('a shift signing in at once', () => {
  // Thresholds are generous against slow CI; the failure being guarded
  // against measured 1,641 ms for twenty.
  it('does not stall the request thread on new hashes', async () => {
    const h = await hashPassword('pass1234');
    const stall = await longestStall(() =>
      Promise.all(Array.from({ length: 20 }, () => verifyPassword('pass1234', h)))
    );
    expect(stall).toBeLessThan(250);
  });

  it('does not stall it on legacy hashes either', async () => {
    // Go-live day: every account still has a bcrypt hash, and every one
    // of them is verified during the first changeover.
    const legacy = bcrypt.hashSync('pass1234', 10);
    const stall = await longestStall(() =>
      Promise.all(Array.from({ length: 20 }, () => verifyPassword('pass1234', legacy)))
    );
    expect(stall).toBeLessThan(250);
  }, 60_000);
});
