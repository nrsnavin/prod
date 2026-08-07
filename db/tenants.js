'use strict';
// ══════════════════════════════════════════════════════════════════
//  PER-USER DATABASE ROUTING
//  File: db/tenants.js
//
//  One API, one URL, two databases: named users work in a SANDBOX
//  database, everyone else in the live one. The sandbox is for trying
//  things on real-shaped data without a mistake reaching production.
//
//  HOW
//  mongoose's connection.useDb() gives a second database handle over the
//  SAME MongoClient — no extra sockets, and a session started on one
//  works on the other, so transactions are unaffected. The request's
//  database is held in an AsyncLocalStorage set once, in setUserContext,
//  the moment the user is known.
//
//  Every model then has to resolve to that database at CALL time, not at
//  require time. Route files hold their models in module scope
//  (`const Order = require('../models/Order')`), so the model object
//  itself has to be the thing that knows — hence the proxy below.
//
//  WHY PATCH mongoose.model RATHER THAN EDIT 57 MODEL FILES
//  Because a model file that got missed would write to the wrong
//  database silently, and there is no test that would notice. Patching
//  the one function every model file calls cannot be partially applied:
//  either routing is installed or it is not.
//
//  WHAT IS NOT ROUTED
//  Logins. `users` always resolves to the primary database, so there is
//  one set of credentials and no way for a sandbox account to become a
//  production one. A sandbox session therefore signs in with the same
//  password as always and sees production's user list.
//
//  KNOWN CONSEQUENCE — ORDER/JOB NUMBER GAPS
//  Order.orderNo and JobOrder.jobOrderNo are allocated by
//  mongoose-sequence, which binds its counter model at plugin time on
//  the default connection. Numbers taken in the sandbox are therefore
//  taken from the LIVE counter, so production sees gaps in its order
//  numbering. Nothing is corrupted and no number is issued twice. The
//  document counters this codebase owns (utils/sequence.js — PO and DC
//  numbers) are routed correctly and are unaffected.
//
//  CONFIGURATION (config/.env)
//    SANDBOX_DB=test
//    SANDBOX_USERS=rsnavin02@gmail.com
//  With SANDBOX_DB unset, routing is inert and every request uses the
//  connected database — which is what every deployment does today.
// ══════════════════════════════════════════════════════════════════

const { AsyncLocalStorage } = require('node:async_hooks');
const mongoose = require('mongoose');

const storage = new AsyncLocalStorage();

/** Models that must never leave the primary database. */
const PINNED_TO_PRIMARY = new Set(['User', 'CustomerUser']);

const listFromEnv = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Read afresh rather than cached, so tests can set the env per case. */
const sandboxDb = () => String(process.env.SANDBOX_DB || '').trim();
const sandboxUsers = () => new Set(listFromEnv(process.env.SANDBOX_USERS));

let warnedSameDb = false;

/**
 * Is SANDBOX_DB the database the app is already connected to?
 *
 * This is the failure that looks like success. Routing "works", every
 * request is served, nothing errors — and the sandbox user is sitting in
 * production, doing the things people do when they believe nothing they
 * touch is real. It happens because a MongoDB URI puts the database in
 * the PATH, so
 *     mongodb+srv://host/?appName=X/mydb        ← no database at all
 * silently connects to `test`, and SANDBOX_DB=test then points at the
 * same place. It has to be
 *     mongodb+srv://host/mydb?appName=X
 */
function sandboxIsPrimary() {
  const db = sandboxDb();
  return Boolean(db) && db === mongoose.connection.name;
}

/**
 * The database this user works in, or null for the primary.
 * Unknown user, no email, or no sandbox configured → primary.
 */
function dbForUser(user) {
  const db = sandboxDb();
  if (!db) return null;

  if (sandboxIsPrimary()) {
    if (!warnedSameDb) {
      warnedSameDb = true;
      // eslint-disable-next-line no-console
      console.error(
        `[tenants] SANDBOX_DB="${db}" is the database MONGO_URL already connects to. ` +
        'Sandbox users would be working in production while believing otherwise, so ' +
        'routing is disabled. Check that MONGO_URL names its database in the PATH: ' +
        'mongodb+srv://host/<database>?options'
      );
    }
    return null;
  }

  const email = user && (user.email || user.get?.('email'));
  if (!email) return null;
  return sandboxUsers().has(String(email).toLowerCase()) ? db : null;
}

// ── Connections ──────────────────────────────────────────────────
const connections = new Map();
const registeredCount = new Map();

/**
 * Register every schema on a secondary connection.
 *
 * populate() resolves a ref through `conn.models[name]` and throws
 * MissingSchemaError when it is absent, so a connection with a partial
 * model set fails on the first join rather than at set-up — which is a
 * bug that only shows on the routes nobody clicked.
 *
 * Re-checked on each use because model files are required lazily: a
 * connection created early would otherwise never learn about a model
 * whose file loaded afterwards.
 */
function registerSchemas(conn) {
  const names = Object.keys(mongoose.models);
  if (registeredCount.get(conn) === names.length) return;
  for (const name of names) {
    if (conn.models[name]) continue;
    const base = mongoose.models[name];
    conn.model(name, base.schema, base.collection.name);
  }
  registeredCount.set(conn, names.length);
}

function connectionFor(dbName) {
  if (!dbName) return mongoose.connection;
  let conn = connections.get(dbName);
  if (!conn) {
    // useCache so repeated calls share one handle; the underlying client
    // (and therefore the socket pool) is the primary's.
    conn = mongoose.connection.useDb(dbName, { useCache: true });
    connections.set(dbName, conn);
  }
  registerSchemas(conn);
  return conn;
}

/** The database name for the request in flight, or null for primary. */
const currentDb = () => storage.getStore()?.dbName ?? null;

/** Run `fn` with every model inside it resolving to `dbName`. */
const runInDb = (dbName, fn) => storage.run({ dbName: dbName || null }, fn);

/** Run `fn` against the primary regardless of the request's database. */
const runOnPrimary = (fn) => storage.run({ dbName: null }, fn);

// ── The proxy ────────────────────────────────────────────────────
/**
 * Wraps a model so every access resolves through the current request's
 * database. On the primary it hands back the real model untouched, so
 * the default path costs one map lookup and no proxying at all.
 */
function tenantAware(model) {
  const name = model.modelName;
  if (PINNED_TO_PRIMARY.has(name)) return model;

  const resolve = () => {
    const dbName = currentDb();
    if (!dbName) return model;
    const conn = connectionFor(dbName);
    return conn.models[name] || conn.model(name, model.schema, model.collection.name);
  };

  return new Proxy(model, {
    get(_target, prop) {
      if (prop === '__baseModel') return model;
      const resolved = resolve();
      // Deliberately NOT bound to `resolved`. Binding returns a copy, so
      // a function carrying its own properties arrives stripped of them —
      // which broke every jest.spyOn in the suite, since spyOn assigns a
      // mock and then reads the property back to return it. Left alone,
      // `this` inside a static is the proxy, and the proxy forwards
      // everything a static touches (collection, db, modelName, new this)
      // to the resolved model anyway.
      return Reflect.get(resolved, prop, resolved);
    },
    set(_target, prop, value) {
      return Reflect.set(resolve(), prop, value);
    },
    has(_target, prop) {
      return Reflect.has(resolve(), prop);
    },
    construct(_target, args) {
      const Resolved = resolve();
      return new Resolved(...args);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolve());
    },
  });
}

// ── Installation ─────────────────────────────────────────────────
let installed = false;

/**
 * Patch mongoose.model so every model file's export is routed.
 *
 * MUST run before the first model file is required. Reading a model
 * (`mongoose.model(name)` with one argument) is passed straight through
 * untouched — only registration is wrapped.
 */
function install() {
  if (installed) return;
  installed = true;

  const original = mongoose.model.bind(mongoose);
  mongoose.model = function patchedModel(name, schema, ...rest) {
    const result = original(name, schema, ...rest);
    if (schema === undefined) return result;      // a lookup, not a registration
    if (typeof result !== 'function') return result;
    return tenantAware(result);
  };
}

/** Test seam — drops cached connections so a case can change the env. */
function _reset() {
  connections.clear();
  registeredCount.clear();
}

module.exports = {
  install,
  tenantAware,
  dbForUser,
  sandboxIsPrimary,
  currentDb,
  connectionFor,
  runInDb,
  runOnPrimary,
  PINNED_TO_PRIMARY,
  _reset,
};
