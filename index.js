const app = require('./app');
const connectDatabase = require('./db/Database');
const path = require('path');

// Handling uncaught Exception
process.on("uncaughtException", (err) => {
  console.log(`Error: ${err.message}`);
  console.log(`shutting down the server for handling uncaught exception`);
});

// dotenv (idempotent — app.js already loads this on require, but keeping
// it here too makes index.js safe to run standalone). Path is absolute so
// it works regardless of process.cwd().
if (process.env.NODE_ENV !== "PRODUCTION") {
  require("dotenv").config({
    path: path.resolve(__dirname, "/.env"),
  });
}

// connect db
connectDatabase.connectDatabase();

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

// unhandled promise rejection
process.on("unhandledRejection", (err) => {
  console.log(`Shutting down the server for ${err.message}`);
  console.log(`shutting down the server for unhandle promise rejection`);

  server.close(() => {
    process.exit(1);
  });
});
