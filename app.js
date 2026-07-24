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
const { isAuthenticated, isAdmin, requireFeature } = require("./middleware/auth.js");

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
// Defence-in-depth global ceiling across the whole API. Generous
// enough that a normal admin session (dashboards fan out many reads)
// never trips it, but it caps scraping / brute-force / DoS on the
// endpoints that aren't individually throttled. The tighter
// loginLimiter still applies on top for /login-user.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  // The web app live-polls every mounted query every 10s, and a whole
  // office can sit behind one NAT IP — e.g. 5 users × 3 queries/10s
  // ≈ 1350 req/15min. Ceiling sized so normal polling never trips it
  // while still capping scraping/brute-force.
  max: 4000,                  // ~4.4 req/s sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests — slow down and try again shortly." },
});

const user     = require("./api/user.js");
const settings = require("./api/settings.js");
const pdfTemplates = require("./api/pdfTemplates.js");
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

// Readiness probe — unlike liveness, this reports whether the process
// can actually serve traffic, i.e. the database connection is up. A
// load balancer should route on THIS (503 → pull the instance out of
// rotation) so requests aren't sent to a box that's up but can't reach
// Mongo. mongoose.connection.readyState === 1 means connected.
app.get("/api/v2/health/ready", (req, res) => {
  const state = mongoose.connection.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
  const ready = state === 1;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not-ready",
    db: ["disconnected", "connected", "connecting", "disconnecting"][state] || "unknown",
  });
});

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

// Phase 4 — per-user FEATURE enforcement (requireFeature, below).
// Layered ON TOP of the role gate for LEAF routers only: planner,
// production, reports, qc, audit here, plus warping/covering/wastage/
// packing which gate themselves inside the router. Leaf = the router's
// data isn't read by other features' screens. Shared master-data routers
// (machine, employee, customer, supplier, order, materials, job, dc,
// elastic) are deliberately NOT feature-gated: their data is fetched
// cross-feature (e.g. Jobs & Planning read /machine; HR & Shifts read
// /employee), so a mount-level feature gate would 403 legitimate reads.
// Those stay on the coarse role gate. requireFeature is also a no-op for
// users with no explicit feature list, so legacy accounts are unaffected.

// Throttle credential-guessing before the login handler runs.
app.use("/api/v2", apiLimiter);
app.use("/api/v2/user/login-user", loginLimiter);
// Unauthenticated, abuse-prone surfaces: forgot-password and both OTP
// legs trigger emails / accept guesses — throttle them on the same tight
// per-IP limiter as login to cap abuse/enumeration/brute-force.
app.use("/api/v2/user/forgot-password", loginLimiter);
app.use("/api/v2/user/request-otp", loginLimiter);
app.use("/api/v2/user/verify-otp", loginLimiter);
// ── Every route carries a role gate ─────────────────────────────────
// Live roles are only admin / production / accounts (roleForDepartment
// derives them from the 5 departments — see utils/roles.js). The old
// 'sales' and 'stores' roles are RETIRED: no department maps to them, so
// any gate that still listed them was dead weight and is removed here.
//
// Each mount's gate is the UNION of the roles its routes actually use,
// so worker (production) and finance (accounts) self-service routes —
// own payslip/leave/attendance/bonus, machine-issue reports, and the
// open reads (settings, elastic stock, announcements, feedback,
// dashboard, PDF templates, Ask Jarvis) — keep working. The routers'
// own per-route isAdmin(...)/selfOrAdmin still enforce the fine grain.
//
// `user` is the one exception: it can't be mount-gated because it hosts
// the public login / OTP / forgot-password endpoints, so it self-gates.
app.use("/api/v2/user", user);
app.use("/api/v2/settings",    gate('production', 'accounts'), settings);
app.use("/api/v2/pdf-templates", gate('production', 'accounts'), pdfTemplates);
// Per-user feature enforcement (writes only — requireFeature passes all
// reads). Machine head assignment is also written from the Jobs screen,
// so /jobs may write here too.
app.use("/api/v2/machine",     gate('production'), requireFeature('/machines', '/jobs'), machine);
app.use("/api/v2/shift",       gate('production'), requireFeature('/shift-plans', '/shift-verification', '/production'), shift);
app.use("/api/v2/customer",    gate('accounts'), requireFeature('/customers'), customer);
app.use("/api/v2/employee",    gate('accounts', 'production'), requireFeature('/employees'), employee);
app.use("/api/v2/elastic",     gate('accounts', 'production'), requireFeature('/elastics'), elastic);
// Elastic groups can be created from the Order form and Customer detail
// (finance flows), so those features may write here too.
app.use("/api/v2/elastic-group", gate('accounts'), requireFeature('/elastic-groups', '/orders', '/customers'), elasticGroup);
app.use("/api/v2/dc",          gate('accounts'), requireFeature('/delivery-challans'), deliveryChallanRouter);
// Purchase orders live on the supplier router, so /purchase-orders writes here.
app.use("/api/v2/supplier",    gate('accounts'), requireFeature('/suppliers', '/purchase-orders'), supplier);
app.use("/api/v2/bonus",       gate('accounts', 'production'), requireFeature('/bonus'), bonus);
app.use("/api/v2/order",       gate('accounts'), requireFeature('/orders'), order);
app.use("/api/v2/planner",     gate('production'), requireFeature('/planner'), planner);
// Ask Jarvis is an always-on feature — open to any authenticated user
// (no role gate), matching the nav. Still requires login.
app.use("/api/v2/assistant",   isAuthenticated, assistant);
app.use("/api/v2/materials",   gate('production', 'accounts'), requireFeature('/materials'), material);
app.use("/api/v2/warping",     gate('production'), warping);
app.use("/api/v2/wastage",     gate('production'), wastage);
app.use("/api/v2/attendance",  gate('accounts', 'production'), requireFeature('/attendance'), attendence);
app.use("/api/v2/covering",    gate('production'), covering);
app.use("/api/v2/job",         gate('production'), requireFeature('/jobs'), job);
app.use("/api/v2/packing",     gate('production'), packing);
// Production View feeds the Analytics dashboards too, so a user with
// either feature may read it.
app.use("/api/v2/production",  gate('production'), requireFeature('/production', '/analytics'), production);
// Management reports span operations and finance — either (or an admin)
// may pull them; each report is read-only.
app.use("/api/v2/reports",     gate('production', 'accounts'), requireFeature('/reports'), require("./api/reports.js"));
// QC is a leaf, but the Jobs screen reads QC results, so /jobs passes too.
app.use("/api/v2/qc",          gate('production'), requireFeature('/qc', '/jobs'), require("./api/qc.js"));
app.use("/api/v2/payroll",     gate('accounts', 'production'), payroll);
app.use("/api/v2/leave",       gate('accounts', 'production'), leave);
app.use("/api/v2/machine-issue", gate('production', 'accounts'), machineIssue);
app.use("/api/v2/announcement", gate('production', 'accounts'), announcement);
app.use("/api/v2/feedback",    gate('production', 'accounts'), feedback);
app.use("/api/v2/dashboard",   gate('production', 'accounts'), dashboard);
// AI Advisor aggregates across every router, which only admin can
// reach, so it stays admin-only (see note re: feature catalog).
app.use("/api/v2/advisor",     gate(), advisor);
app.use("/api/v2/io",          gate(), io);
app.use("/api/v2/audit",       ADMIN_GATE, requireFeature('/audit'), audit);

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
