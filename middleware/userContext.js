const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');
const jwt = require('jsonwebtoken');
const User = require('../models/User.js');
const { dbForUser, runInDb } = require('../db/tenants.js');

// Per-request store for the authenticated user. Schema pre-save hooks
// (see models/plugins/auditFields.js) read from here to stamp
// createdBy/updatedBy without every controller threading req.user through.
const userStorage = new AsyncLocalStorage();

// Optional auth: if a valid JWT cookie is present, attach req.user and
// run the rest of the request inside the user-context store. Never blocks
// — unauthenticated routes (login, sign-up) keep working as before.
const setUserContext = async (req, res, next) => {
  try {
    const { token } = req.cookies || {};
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      // Accept both 'id' (canonical) and 'userid' (legacy) payload shapes.
      const userId = decoded.id || decoded.userid;
      if (userId) {
        req.user = await User.findById(userId);
      }
    }
  } catch (_) {
    // Invalid/expired token — ignore so unauth routes still work.
  }

  if (req.user) {
    // The database is decided here and nowhere else: this is the first
    // point at which the user is known, and it is before any route has
    // touched a model. `users` itself is pinned to the primary (see
    // db/tenants.js), so the lookup above is unaffected by the answer.
    req.tenantDb = dbForUser(req.user);
    return userStorage.run({ user: req.user }, () =>
      runInDb(req.tenantDb, () => next())
    );
  }
  next();
};

// ══════════════════════════════════════════════════════════════════
//  KEEPING THE REQUEST'S CONTEXT ACROSS A FILE UPLOAD
//
//  Both stores above are AsyncLocalStorage, established once here and
//  read everywhere: `userStorage` stamps createdBy/updatedBy, and the
//  tenant store decides WHICH DATABASE every model resolves to.
//
//  AsyncLocalStorage follows the async resource that scheduled a
//  callback. `express.json` is mounted BEFORE setUserContext, so by the
//  time the store exists the body is already parsed and every JSON
//  handler runs synchronously from next() — inside the store, correctly.
//
//  multer is mounted AFTER, inside the routers. It consumes the request
//  stream and calls next() from a STREAM EVENT, and that event is
//  emitted by the socket — an async resource created when the
//  connection was accepted, long before this request had a user. So the
//  handler runs with an EMPTY store:
//
//    • currentDb() → null → every model silently resolves to the LIVE
//      database, whoever the user is. A sandbox user's uploads land in
//      production, which is the exact thing db/tenants.js exists to
//      prevent.
//    • getCurrentUser() → null → the upload is saved unattributed.
//
//  And it depends on SIZE, which is why it survived so long. A few
//  bytes arrive in one chunk and busboy finishes synchronously, inside
//  the store; every test used a 15-byte fixture and passed. A real
//  photo does not:
//
//        16 B  → "This request read database sandbox_db."
//       900 KB → "This request read database primary_db. No signed-in user."
//
//  AsyncResource.bind captures the context at bind time — here, inside
//  the store — and restores it when multer eventually calls next().
// ══════════════════════════════════════════════════════════════════

/**
 * Wrap a middleware that finishes from a stream event (any multer
 * upload) so the request's stores survive it.
 */
const keepRequestContext = (middleware) => (req, res, next) =>
  middleware(req, res, AsyncResource.bind(next));

const getCurrentUser = () => userStorage.getStore()?.user || null;

module.exports = { setUserContext, getCurrentUser, keepRequestContext };
