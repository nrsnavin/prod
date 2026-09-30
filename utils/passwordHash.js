'use strict';
// ══════════════════════════════════════════════════════════════════
//  PASSWORD HASHING THAT DOES NOT STOP THE SERVER
//
//  Passwords were hashed with bcryptjs — pure JavaScript, on the one
//  thread that serves every request. Its "async" API looks harmless
//  but chains its work through process.nextTick, which runs before the
//  event loop can service anything else. Measured here: twenty
//  concurrent logins stalled the request thread for 1,641 ms in one
//  piece. A mill signs a whole shift in within a few minutes, so that
//  is the worst-shaped load this system meets.
//
//  NEW hashes use crypto.scrypt, which runs on libuv's thread pool: the
//  same twenty took 287 ms wall-clock with a longest stall of 5 ms.
//  The parameters are libsodium's "interactive" set (N=2^14, r=8, p=1;
//  16 MiB per hash), chosen for a small server under cluster mode.
//  They are written into every hash, so they can be raised later and
//  each account upgrades itself at its next login — no migration.
//
//      scrypt$<N>$<r>$<p>$<salt, base64>$<key, base64>
//
//  LEGACY bcrypt hashes still verify, on a worker thread
//  (utils/workerPool.js), and report `needsRehash` so the caller can
//  replace them with scrypt once the password is known to be right.
//  After one successful login per person, bcrypt is gone from the
//  request path entirely.
// ══════════════════════════════════════════════════════════════════

const crypto = require('node:crypto');
const { runJob } = require('./workerPool');

const CURRENT = Object.freeze({ N: 16384, r: 8, p: 1 });
const KEY_LEN = 64;
const SALT_LEN = 16;
const PREFIX = 'scrypt$';
const BCRYPT = /^\$2[aby]\$\d{2}\$/;

/** scrypt needs about 128·N·r bytes; Node refuses above maxmem. */
const maxmemFor = ({ N, r, p }) => 128 * N * r * p + 1024 * 1024;

function scrypt(plain, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, KEY_LEN, { ...params, maxmem: maxmemFor(params) }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

/** Hash a new password. */
async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('A password is required');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(plain, salt, CURRENT);
  const { N, r, p } = CURRENT;
  return `${PREFIX}${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseScrypt(stored) {
  const parts = stored.split('$');
  // ['scrypt', N, r, p, salt, key]
  if (parts.length !== 6) return null;
  const [, N, r, p, salt, key] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Object.values(params).every((v) => Number.isInteger(v) && v > 0)) return null;
  // N must be a power of two; anything else is a corrupt record, not a
  // weaker one, and should not reach crypto.scrypt as a throw.
  if ((params.N & (params.N - 1)) !== 0) return null;
  return { params, salt: Buffer.from(salt, 'base64'), key: Buffer.from(key, 'base64') };
}

const weakerThanCurrent = ({ N, r, p }) =>
  N < CURRENT.N || r < CURRENT.r || p < CURRENT.p;

async function bcryptCompare(plain, stored) {
  try {
    return await runJob('password.bcryptCompare', [plain, stored], { timeoutMs: 15_000 });
  } catch (err) {
    // No worker to be had. Verifying on this thread is slower for
    // everyone else, but refusing a correct password is worse.
    if (err?.code === 'WORKER_UNAVAILABLE') {
      return require('bcryptjs').compare(plain, stored);
    }
    throw err;
  }
}

/**
 * Check a password against a stored hash.
 *
 * @returns {Promise<{ ok: boolean, needsRehash: boolean }>}
 *   `needsRehash` is only ever true alongside `ok`: a hash is upgraded
 *   when the password has just been proven, never on a guess.
 */
async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string' || !plain || !stored) {
    return { ok: false, needsRehash: false };
  }

  if (stored.startsWith(PREFIX)) {
    const parsed = parseScrypt(stored);
    if (!parsed) return { ok: false, needsRehash: false };
    const key = await scrypt(plain, parsed.salt, parsed.params);
    const ok = key.length === parsed.key.length && crypto.timingSafeEqual(key, parsed.key);
    return { ok, needsRehash: ok && weakerThanCurrent(parsed.params) };
  }

  if (BCRYPT.test(stored)) {
    const ok = await bcryptCompare(plain, stored);
    return { ok: !!ok, needsRehash: !!ok };
  }

  return { ok: false, needsRehash: false };
}

/**
 * A hash that matches nothing, for the unknown-account path.
 *
 * Login answers "invalid email or password" either way, but answered
 * instantly when the email is unknown and after a hash when it is known
 * — so the response TIME said which emails are registered. Verifying
 * against this makes both paths do the same work.
 */
let dummy = null;
function dummyHash() {
  if (!dummy) dummy = hashPassword(crypto.randomBytes(24).toString('base64'));
  return dummy;
}

module.exports = {
  hashPassword,
  verifyPassword,
  dummyHash,
  CURRENT_PARAMS: CURRENT,
  isLegacyHash: (h) => typeof h === 'string' && BCRYPT.test(h),
};
