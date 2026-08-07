const { AsyncLocalStorage } = require('node:async_hooks');
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

const getCurrentUser = () => userStorage.getStore()?.user || null;

module.exports = { setUserContext, getCurrentUser };
