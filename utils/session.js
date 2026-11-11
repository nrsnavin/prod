'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOGIN SESSION — issued, checked and ended in one place
//
//  The token, its cookie and the check on every request were spread over
//  three files that had drifted apart: the request-context middleware
//  accepted a token whose sessions had been ended, the cookie's options
//  were copied five times, and nothing could end ONE session — logging
//  out on the office desktop cleared the page and left the cookie good
//  for the rest of its day.
//
//    issue(user)        the token: who, the generation of the account's
//                       sessions (`v`) and this session's own id (`sid`)
//    cookieOptions()    how its cookie is set, everywhere it is set
//    read(token)        the user and claims of a session that still
//                       stands, or a 401 that says why not
//    end(user, claims)  ends this one session (sign-out)
//    endAll(userId)     ends every session of the account (lost phone,
//                       password changed)
//    closedReason(user) why this login may not be used at all, or null
//
//  A session stands when the token verifies, the account exists, the
//  account's sessions have not all been ended since (`v`), this one has
//  not been signed out (`sid`), and the login is not closed. Tokens from
//  before `v` or `sid` existed carry neither and are honoured until they
//  expire, so a deploy signs nobody out.
//
//  A login is closed when the employee it belongs to has left: from the
//  day after their last working day it can neither sign in nor go on
//  using a session it already has. (Offboarding used to close a worker's
//  phone sign-in and leave everything else — a manager's login, a code
//  sent to an email, a phone that was already signed in.) An
//  administrator's login is never closed this way: an HR entry must not
//  be a way to lock the owner out.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const ErrorHandler = require('./ErrorHandler');

const WEB_SESSION = '24h';
const APP_SESSION = '90d';
const WEB_MAX_AGE = 24 * 60 * 60 * 1000;
const APP_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
// The one algorithm tokens are signed with; nothing else is accepted.
const ALGORITHMS = ['HS256'];
// Sign-outs remembered per account. Each is forgotten when its token
// would have expired anyway, so the list stays a handful long.
const MAX_REMEMBERED = 50;

const COOKIE = 'token';

/**
 * SameSite for the session cookie. "none" (the default, as before) lets
 * a web app on ANOTHER site use the API; set SESSION_SAMESITE=lax when
 * the web app and the API share a site (erp.example.com and
 * api.example.com do), and no other site's page can send the cookie.
 */
function sameSite() {
  const v = String(process.env.SESSION_SAMESITE || 'none').toLowerCase();
  return ['lax', 'strict', 'none'].includes(v) ? v : 'none';
}

/** How the session cookie is set. */
function cookieOptions({ longLived = false } = {}) {
  return { httpOnly: true, sameSite: sameSite(), secure: true, maxAge: longLived ? APP_MAX_AGE : WEB_MAX_AGE };
}

/** The same cookie, expired now. */
function clearedCookieOptions() {
  return { httpOnly: true, sameSite: sameSite(), secure: true, expires: new Date(0) };
}

/** True when the caller says it is the mobile app, which asks for the long session. */
function wantsLongSession(req) {
  return String(req.get('X-Client') || '').toLowerCase() === 'mobile';
}

/**
 * A session token for `user`. A renewal passes the session's own `sid`,
 * so one sign-in stays one session however often the app is opened, and
 * signing out ends every token it was renewed into.
 */
function issue(user, { longLived = false, sid } = {}) {
  return jwt.sign(
    {
      id: user._id,
      username: user.name,
      role: user.role,
      // The generation of the account's sessions; see read().
      v: user.tokenVersion ?? 0,
      // This session's own id, so it can be ended on its own.
      sid: typeof sid === 'string' && sid ? sid : crypto.randomBytes(12).toString('hex'),
    },
    process.env.JWT_SECRET_KEY,
    { expiresIn: longLived ? APP_SESSION : WEB_SESSION, algorithm: ALGORITHMS[0] }
  );
}

const signedOut = () => new ErrorHandler('You have been signed out. Please login again.', 401);
const invalid = () => new ErrorHandler('Session is invalid — please login again', 401);

const CLOSED = 'This login is closed — the employee it belongs to no longer works here. Ask an administrator.';

/**
 * Why `user` may not use the system at all, or null when they may.
 * Read from the employee record each time, so reinstating someone (or
 * correcting their last day) opens the login again with nothing to undo.
 */
async function closedReason(user) {
  if (!user?.employee || user.role === 'admin') return null;
  const Employee = require('../models/Employee');
  const { leftBefore, factoryToday } = require('./employeeStatus');
  let emp;
  try {
    emp = await Employee.findById(user.employee._id || user.employee)
      .select('status offboarding.lastWorkingDay').lean();
  } catch (_) {
    return null; // a link that is not an id closes nothing
  }
  return emp && leftBefore(emp, factoryToday()) ? CLOSED : null;
}

/**
 * The session a token stands for.
 * @returns {Promise<{ user, claims }>}
 * @throws ErrorHandler 401 — always 401, so every client sends the person
 *         back to sign in (an expired token used to be a 400 about a URL).
 */
async function read(token) {
  let claims;
  try {
    claims = jwt.verify(String(token || ''), process.env.JWT_SECRET_KEY, { algorithms: ALGORITHMS });
  } catch (err) {
    throw err?.name === 'TokenExpiredError'
      ? new ErrorHandler('Your session has expired. Please login again.', 401)
      : invalid();
  }
  // Both payload shapes: `id` (canonical) and `userid` (legacy).
  const userId = claims.id || claims.userid;
  if (!userId) throw invalid();

  const User = require('../models/User');
  let user;
  try {
    user = await User.findById(userId).select('+revokedSessions');
  } catch (_) {
    throw invalid(); // an id that is not an id
  }
  if (!user) throw invalid();

  if (claims.v !== undefined && claims.v !== (user.tokenVersion ?? 0)) throw signedOut();
  if (claims.sid && (user.revokedSessions || []).some((s) => s.sid === claims.sid)) throw signedOut();
  const closed = await closedReason(user);
  if (closed) {
    const err = new ErrorHandler(closed, 401);
    err.code = 'LOGIN_CLOSED';
    throw err;
  }
  return { user, claims };
}

/** End this one session: its token is refused from now on. */
async function end(user, claims) {
  if (!user?._id || !claims?.sid) return false; // an older token: nothing to remember it by
  const User = require('../models/User');
  // An app session is renewed in place (the same sid, a fresh ninety days)
  // each time the app opens, so the token signed out with may not be its
  // newest: remember the sign-out for as long as a renewal could last. A
  // browser's session is never renewed and is forgotten with its token.
  const longLived = claims.exp && claims.iat && (claims.exp - claims.iat) * 1000 > WEB_MAX_AGE;
  const exp = claims.exp && !longLived ? new Date(claims.exp * 1000) : new Date(Date.now() + APP_MAX_AGE);
  // Forget the ones whose tokens have expired on their own, then remember this one.
  await User.updateOne({ _id: user._id }, { $pull: { revokedSessions: { exp: { $lt: new Date() } } } });
  await User.updateOne(
    { _id: user._id },
    { $push: { revokedSessions: { $each: [{ sid: claims.sid, exp }], $slice: -MAX_REMEMBERED } } }
  );
  return true;
}

/** End every session of the account, on every device. */
async function endAll(userId) {
  const User = require('../models/User');
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 }, $unset: { revokedSessions: 1 } });
}

module.exports = {
  COOKIE, WEB_MAX_AGE, APP_MAX_AGE, ALGORITHMS,
  issue, read, end, endAll, closedReason, cookieOptions, clearedCookieOptions, wantsLongSession, sameSite,
};
