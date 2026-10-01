'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO GETS COUNTED AS WHOM
//
//  Every limiter here used to key on the client's IP and keep its
//  counters in process memory. Both choices broke at the size this
//  system is heading for, and both broke in the same place: a mill
//  office, where everybody reaches the internet through ONE address.
//
//    • The API ceiling (4,000 requests / 15 min / IP) was one bucket
//      for the whole building. The web app polls every mounted query
//      every 10 s, so the office tripped it together at roughly fifteen
//      users — and a 429 does not slow anyone down, it stops everyone.
//
//    • The login throttle counted SUCCESSFUL logins as attempts. Twenty
//      a quarter-hour per IP meant the twenty-first worker signing in on
//      the office Wi-Fi at shift changeover was locked out for fifteen
//      minutes, having typed nothing wrong.
//
//  Now:
//    api      — keyed on the signed-in USER; on IP only before sign-in.
//               setUserContext runs earlier in app.js, so req.user is
//               already known here without a second token check.
//    login    — counts FAILURES only, per account per address, with a
//               looser per-address cap on failures across accounts so
//               one address cannot walk the user list.
//    otp      — unchanged in spirit (per address, every request counts):
//               those routes send email, so a success costs something.
//    webhook  — per address, as before.
//
//  All of them keep their counters in MongoDB (utils/rateLimitStore.js)
//  so they mean the same thing with one process or eight.
// ══════════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { MongoRateLimitStore } = require('../utils/rateLimitStore');

const FIFTEEN_MIN = 15 * 60 * 1000;

const ipKey = (req) => `ip:${ipKeyGenerator(req.ip || '')}`;

/** The signed-in user if there is one; the address only before sign-in. */
const userOrIpKey = (req) => (req.user?._id ? `u:${req.user._id}` : ipKey(req));

/** One account at one address. Lower-cased: the login route matches case-sensitively, an attacker need not. */
const accountKey = (req) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (email) return `${ipKey(req)}|${email}`;
  // Worker sign-in names the account by phone, not email. Digits only,
  // so "98765 43210" and "9876543210" are one account here too.
  const phone = typeof req.body?.phone === 'string' || typeof req.body?.phone === 'number'
    ? String(req.body.phone).replace(/\D/g, '').slice(-10) : '';
  return `${ipKey(req)}|${phone ? `phone:${phone}` : ''}`;
};

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  // A counter we cannot write is a request we let through — see the
  // store's header. The store already fails open on its own errors;
  // this covers anything thrown around it.
  passOnStoreError: true,
};

/**
 * Build every limiter. Limits are parameters so a test can exercise the
 * real middleware at a size it can actually reach.
 */
function buildLimiters({
  apiLimit = 4000,
  loginPerAccount = 20,
  loginPerAddress = 100,
  otpLimit = 20,
  webhookLimit = 30,
  storeFor = (prefix) => new MongoRateLimitStore({ prefix }),
} = {}) {
  const apiLimiter = rateLimit({
    ...common,
    windowMs: FIFTEEN_MIN,
    // Per person, so one busy user cannot spend the office's allowance
    // and an office cannot spend one person's. At the current 10 s poll
    // a user with three live queries uses ~270 of these per window.
    limit: apiLimit,
    keyGenerator: userOrIpKey,
    store: storeFor('rl:api:'),
    message: { success: false, message: 'Too many requests — slow down and try again shortly.' },
  });

  const loginMessage = { success: false, message: 'Too many login attempts — try again later.' };

  const loginAccountLimiter = rateLimit({
    ...common,
    windowMs: FIFTEEN_MIN,
    limit: loginPerAccount,
    // Only a wrong password is an attempt. A hundred people signing in
    // correctly from one office cost nothing.
    skipSuccessfulRequests: true,
    keyGenerator: accountKey,
    store: storeFor('rl:login-acct:'),
    message: loginMessage,
  });

  const loginAddressLimiter = rateLimit({
    ...common,
    windowMs: FIFTEEN_MIN,
    limit: loginPerAddress,
    skipSuccessfulRequests: true,
    keyGenerator: ipKey,
    store: storeFor('rl:login-ip:'),
    message: loginMessage,
  });

  const otpLimiter = rateLimit({
    ...common,
    windowMs: FIFTEEN_MIN,
    limit: otpLimit,
    keyGenerator: ipKey,
    store: storeFor('rl:otp:'),
    message: loginMessage,
  });

  const webhookLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: webhookLimit,
    keyGenerator: ipKey,
    store: storeFor('rl:webhook:'),
    message: { success: false, message: 'Rate limit exceeded.' },
  });

  return { apiLimiter, loginAccountLimiter, loginAddressLimiter, otpLimiter, webhookLimiter };
}

module.exports = { buildLimiters, userOrIpKey, accountKey, ipKey };
