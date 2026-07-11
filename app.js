const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

if (process.env.NODE_ENV !== "PRODUCTION") {
  require("dotenv").config({
    path: path.resolve(__dirname, "config/.env"),
  });
}

const auditFields = require("./models/plugins/auditFields.js");
mongoose.plugin(auditFields);

const ErrorHandler = require("./middleware/error.js");
const app = express();
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const sanitizeMongo = require("./middleware/sanitizeMongo.js");
const { setUserContext } = require("./middleware/userContext.js");
const { isAuthenticated, isAdmin } = require("./middleware/auth.js");

// Trust the reverse proxy (nginx/ALB) so req.protocol, req.ip, and the
// `secure` cookie flag reflect the real client connection rather than
// the proxy hop. Required for rate-limit keying and HTTPS detection.
app.set("trust proxy", 1);

// Constant-time string comparison for shared secrets (cron header).
// Avoids the timing side-channel of `===` on secret material.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Brute-force / abuse throttles. Keyed per-IP (trust proxy is set so
// the real client IP is used behind the reverse proxy).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  max: 20,                    // 20 attempts / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts — try again later." },
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 min
  max: 30,                    // 30 inbound webhook hits / IP / min
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Rate limit exceeded." },
});

const user     = require("./api/user.js");
const advisor  = require("./api/advisor.js");
const io       = require("./api/io.js");
const audit    = require("./api/audit.js");
const machine  = require("./api/machine.js");
const shift    = require("./api/shift.js");
const employee = require("./api/employee.js");
const customer = require("./api/customer.js");
const supplier = require("./api/supplier.js");
const material = require("./api/rawMaterial.js");
const elastic  = require("./api/elastic.js");
const elasticGroup = require("./api/elasticGroup.js");
const order    = require("./api/order.js");
const planner  = require("./api/planner.js");
const assistant = require("./api/assistant.js");
const job      = require("./api/job.js");
const warping  = require("./api/warping.js");
const covering = require("./api/covering.js");
const packing  = require("./api/packing.js");
const bonus    = require("./api/bonus.js");
const deliveryChallanRouter = require("./api/deliveryChallan.js");
const production  = require("./api/production.js");
const wastage     = require("./api/wastage.js");
const attendence  = require("./api/attendence.js");
const payroll     = require("./api/payroll.js");
const leave       = require("./api/leave.js");
const machineIssue = require("./api/machineIssue.js");
const announcement = require("./api/announcement.js");
const feedback     = require("./api/feedback.js");
const dashboard    = require("./api/dashboard.js");
const notify       = require("./api/notify.js");

// Customer-facing portal API (v3 namespace). Separate auth surface
// from the admin/employee app — see middleware/portalAuth.js for
// the three-layer separation (cookie, secret, audience claim).
const portalAuth = require("./api/portal/auth.js");

// CORS allow-list. Browsers enforce CORS; non-browser clients (the
// Flutter app via Dio, curl, server-to-server) send no Origin header
// and are always allowed. Browser origins must be explicitly listed
// in CORS_ORIGINS (comma-separated) — reflecting any origin while
// credentials:true is on would let any website drive the API as a
// logged-in admin. Localhost dev origins are allowed by default.
const _allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);
const _devOrigins = [
  "http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000",
];
if (process.env.NODE_ENV !== "PRODUCTION") {
  _devOrigins.forEach((o) => _allowedOrigins.add(o));
}
const corsConfig = {
  origin(origin, cb) {
    // No Origin header → non-browser client (mobile/curl/server). Allow.
    if (!origin) return cb(null, true);
    if (_allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  credentials: true,
};

app.use(helmet());
app.use(cors(corsConfig));
app.options('*', cors(corsConfig));
// Bound the JSON body. The default (100kb) is fine for this API; the
// old 50mb urlencoded ceiling was a DoS amplifier for the bulk-array
// endpoints. File uploads use multer (memoryStorage, own 5mb cap).
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));

// Strip Mongo operator keys ($-prefixed / dotted) from all inputs.
app.use(sanitizeMongo);

// One JSON line per completed request (method, path, status, ms,
// user when authenticated). Zero-dep stand-in for morgan.
app.use(require("./middleware/requestLogger"));

// Public static — daily report PDFs (utils/reportPublisher.js writes
// here). These MUST stay reachable without auth because Twilio fetches
// the PDF by URL to attach it to the WhatsApp message. The confidential-
// ity control is therefore an UNGUESSABLE filename: reportPublisher.js
// appends 128 bits of crypto-random entropy to each name, and files are
// swept after 14 days. Directory listing is off by default in
// express.static; `index:false` and `dotfiles:"deny"` make that explicit
// and keep .gitkeep and any dotfile unreachable.
app.use("/public", express.static(require("path").join(__dirname, "public"), {
  fallthrough: true,
  index: false,
  dotfiles: "deny",
  maxAge: "1h",
  setHeaders(res) {
    // helmet sets Cross-Origin-Resource-Policy: same-origin globally;
    // relax it here so Twilio's media fetch of the report PDF isn't
    // blocked. (CORP is browser-enforced, but this keeps the contract
    // explicit and future-proof against a stricter default.)
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  },
}));

app.use(setUserContext);

// Unauthenticated liveness probe for load balancers / uptime checks.
// Deliberately mounted before the routers so it never touches auth
// or the database.
app.get("/api/v2/health", (req, res) =>
  res.json({ status: "ok", uptime: process.uptime() })
);

// Build-info probe — exposes the commit SHA + start time + a quick
// inventory of marker routes so you can verify what's actually
// running on this host. Unauthenticated so a curl from any machine
// works ("did the deploy land?" is the most common ops question).
//
// Best-effort SHA discovery: env var first (typical CI artefact),
// then .git/HEAD walk if the repo is bundled with the deploy, then
// "unknown". Never throws — health probes must always respond.
const fs   = require("fs");
const path2 = require("path");
function _readCommitSha() {
  if (process.env.GIT_COMMIT_SHA) return process.env.GIT_COMMIT_SHA;
  if (process.env.COMMIT_SHA)     return process.env.COMMIT_SHA;
  try {
    const head = fs.readFileSync(path2.join(__dirname, ".git/HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5);
      return fs.readFileSync(path2.join(__dirname, ".git", ref), "utf8").trim();
    }
    return head;
  } catch (_) {
    return "unknown";
  }
}
const _BOOT_AT  = new Date();
const _BOOT_SHA = _readCommitSha();
// Detailed build info (commit SHA, Node version, route inventory) is a
// fingerprinting aid for attackers, so it's admin-gated. Ops still gets
// it with an admin session.
app.get("/api/v2/health/build", isAuthenticated, isAdmin("admin"), (req, res) => {
  res.json({
    status:        "ok",
    commitSha:     _BOOT_SHA,
    startedAt:     _BOOT_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node:          process.version,
    env:           process.env.NODE_ENV || "development",
    routes: {
      "/api/v2/order/estimate-completion":    true,
      "/api/v2/order/:id/running-eta":        true,
      "/api/v2/order/running-eta-bulk":       true,
      "/api/v3/portal/auth/login":            true,
    },
  });
});


// Mount-level admin gate for the all-ADMIN router groups.
//
// Mixed-auth routers (attendance, payroll, bonus, shift, packing, wastage,
// machine-issue, warping, covering, elastic, dc) wire isAuthenticated +
// per-route isAdmin('admin') inside the router itself — they're NOT in
// this admin block. Elastic needs a worker-facing GET /:id/stock for the
// stock screen; DC defers admin gating per-route as well.
//
// Per-route auth routers (user, announcement, feedback, leave, dashboard)
// also handle their own middleware to allow login + employee-facing reads.
const ADMIN_GATE = [isAuthenticated, isAdmin('admin')];

// ── Department roles (segregation of duties) ────────────────────────
// 'admin' passes every gate; department roles unlock only their area.
// This lets a stores clerk receive goods without being able to run
// payroll, and a sales user manage orders without touching machines.
// Assign via User.role: admin | sales | stores | production | accounts
const gate = (...roles) => [isAuthenticated, isAdmin('admin', ...roles)];

// Throttle credential-guessing before the login handler runs.
app.use("/api/v2/user/login-user", loginLimiter);
app.use("/api/v2/user", user);
app.use("/api/v2/machine",     gate('production'), machine);
app.use("/api/v2/shift",       shift);
app.use("/api/v2/customer",    gate('sales'), customer);
app.use("/api/v2/employee",    gate('accounts', 'production'), employee);
app.use("/api/v2/elastic",     elastic);
app.use("/api/v2/elastic-group", elasticGroup);
app.use("/api/v2/dc",          gate('sales', 'stores'), deliveryChallanRouter);
app.use("/api/v2/supplier",    gate('stores'), supplier);
app.use("/api/v2/bonus",       bonus);
app.use("/api/v2/order",       gate('sales'), order);
app.use("/api/v2/planner",     gate('production'), planner);
app.use("/api/v2/assistant",   assistant);
app.use("/api/v2/materials",   gate('stores', 'production'), material);
app.use("/api/v2/warping",     warping);
app.use("/api/v2/wastage",     wastage);
app.use("/api/v2/attendance",  attendence);
app.use("/api/v2/covering",    covering);
app.use("/api/v2/job",         gate('production'), job);
app.use("/api/v2/packing",     packing);
app.use("/api/v2/production",  gate('production'), production);
app.use("/api/v2/qc",          gate('production'), require("./api/qc.js"));
app.use("/api/v2/payroll",     payroll);
app.use("/api/v2/leave",       leave);
app.use("/api/v2/machine-issue", machineIssue);
app.use("/api/v2/announcement", announcement);
app.use("/api/v2/feedback",    feedback);
app.use("/api/v2/dashboard",   dashboard);
app.use("/api/v2/advisor",     advisor);
app.use("/api/v2/io",          io);
app.use("/api/v2/audit",       ADMIN_GATE, audit);

// Cron-triggerable morning digest — authenticated by a shared secret
// header instead of an admin session, so an external scheduler (system
// crontab, cloud scheduler) can fire it at ~9 AM with a plain curl:
//   curl -X POST -H "x-cron-secret: $CRON_SECRET" \
//        http://host/api/v2/notify/cron/run-digest
// Mounted BEFORE the admin-gated /notify router so the gate doesn't
// intercept it. No-ops with 503 if CRON_SECRET isn't configured.
app.post("/api/v2/notify/cron/run-digest", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, message: "CRON_SECRET not configured" });
  }
  if (!safeEqual(req.get("x-cron-secret"), secret)) {
    return res.status(401).json({ success: false, message: "bad cron secret" });
  }
  try {
    const result = await notify.runDigest(false);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Cron-triggerable 9 PM evening report — production + wastage +
// deliveries for TODAY. Same shared-secret pattern as the digest.
//   curl -X POST -H "x-cron-secret: $CRON_SECRET" \
//        http://host/api/v2/notify/cron/run-evening-report
app.post("/api/v2/notify/cron/run-evening-report", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, message: "CRON_SECRET not configured" });
  }
  if (!safeEqual(req.get("x-cron-secret"), secret)) {
    return res.status(401).json({ success: false, message: "bad cron secret" });
  }
  try {
    const result = await notify.runEveningReport(false);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Public inbound WhatsApp webhook — Twilio POSTs replies here.
// Twilio sends application/x-www-form-urlencoded, so we don't need
// the JSON parser, but the body parser is already mounted at app
// scope. Auth is the Twilio signature + sender allow-list (inside
// the handler), NOT the admin JWT — Twilio has neither.
app.post("/api/v2/notify/incoming", webhookLimiter, async (req, res) => {
  try {
    const r = await notify.handleIncoming(req);
    res.status(r.status).type("text/xml").send(r.body);
  } catch (err) {
    console.warn(`[whatsapp:incoming] handler crashed: ${err?.message}`);
    res.status(500).type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, internal error.</Message></Response>`
    );
  }
});

app.use("/api/v2/notify",      ADMIN_GATE, notify);

// ── Customer portal API (v3) ────────────────────────────────────
// Mounted unauthenticated at the router level — the portal auth
// middleware is applied per-router (login is public, /me is gated).
app.use("/api/v3/portal/auth", portalAuth);


app.use(ErrorHandler);

module.exports = app;
