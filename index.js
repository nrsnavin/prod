const app = require('./app');
const connectDatabase = require('./db/Database');
const path = require('path');

// Handling uncaught Exception
//
// This used to log "shutting down the server" and then carry on running.
// After an uncaught exception the process is in an undefined state —
// a request may have been abandoned mid-transaction, a listener may be
// half-registered — and serving traffic from it is worse than being down,
// because the failure is silent. Exit non-zero and let systemd restart a
// clean process (deploy/jarvis.service, Restart=on-failure).
process.on("uncaughtException", (err) => {
  console.error(`Uncaught exception: ${err?.message}`);
  console.error(err?.stack);
  process.exit(1);
});

// dotenv (idempotent — app.js already loads this on require, but keeping
// it here too makes index.js safe to run standalone). Path is absolute so
// it works regardless of process.cwd().
if (process.env.NODE_ENV !== "PRODUCTION") {
  // "config/.env", not "/.env". path.resolve DISCARDS everything before
  // an absolute segment, so `path.resolve(__dirname, "/.env")` was the
  // filesystem root — a path that does not exist, loading nothing, and
  // saying nothing about it. It has been harmless only because app.js
  // is required on the line above and loads the real file first; the
  // moment anything reordered that, this process would start with no
  // configuration and connect wherever a stray environment variable
  // pointed it.
  require("dotenv").config({
    path: path.resolve(__dirname, "config/.env"),
  });
}

// connect db
connectDatabase.connectDatabase().then(() => {
  // Say whether per-user database routing is actually on. It is
  // configured through systemd's EnvironmentFile (NODE_ENV=PRODUCTION
  // makes node skip config/.env entirely), so "I added SANDBOX_DB and
  // nothing happened" is the normal way this goes wrong — the running
  // process simply never saw the variable. One line here answers it.
  console.log(`[tenants] ${require('./db/tenants.js').describeRouting()}`);
});

// Transactional-outbox dispatcher — delivers alerts enqueued inside
// business transactions (utils/outbox.js), with retry + backoff.
require("./utils/outbox").startOutboxDispatcher();

// create server
//
// HOST controls the bind address. Left unset it binds all interfaces
// (0.0.0.0) — the historical behaviour, fine for direct access. Behind
// a TLS reverse proxy (nginx/Caddy) set HOST=127.0.0.1 so the plaintext
// port is reachable ONLY from the proxy on the same box and never from
// the public internet. See deploy/TLS_SETUP.md.
const HOST = process.env.HOST;
const onListen = () =>
  console.log(
    `Server is running on http://${HOST || "0.0.0.0"}:${process.env.PORT}`
  );
const server = HOST
  ? app.listen(process.env.PORT, HOST, onListen)
  : app.listen(process.env.PORT, onListen);

// unhandled promise rejection — drain in-flight requests, then exit so the
// supervisor brings up a clean process.
process.on("unhandledRejection", (err) => {
  console.error(`Unhandled rejection: ${err?.message}`);
  console.error(err?.stack);
  server.close(() => process.exit(1));
  // Don't hang forever if a keep-alive connection refuses to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
});

// SIGTERM is what systemd sends on `restart` and `stop`. Closing the
// listener first lets in-flight requests finish instead of being cut off
// mid-write — which matters here because several routes are partway
// through a Mongo transaction at any given moment.
process.on("SIGTERM", () => {
  console.log("SIGTERM received — draining connections");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
