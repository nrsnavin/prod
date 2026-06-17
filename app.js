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
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const cors = require("cors");
const { setUserContext } = require("./middleware/userContext.js");
const { isAuthenticated, isAdmin } = require("./middleware/auth.js");

const user     = require("./api/user.js");
const advisor  = require("./api/advisor.js");
const io       = require("./api/io.js");
const machine  = require("./api/machine.js");
const shift    = require("./api/shift.js");
const employee = require("./api/employee.js");
const customer = require("./api/customer.js");
const supplier = require("./api/supplier.js");
const material = require("./api/rawMaterial.js");
const elastic  = require("./api/elastic.js");
const order    = require("./api/order.js");
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

// Customer-facing portal API (v3 namespace). Separate auth surface
// from the admin/employee app — see middleware/portalAuth.js for
// the three-layer separation (cookie, secret, audience claim).
const portalAuth = require("./api/portal/auth.js");

const corsConfig = {
  origin: true,
  credentials: true,
};

app.use(cors(corsConfig));
app.options('*', cors(corsConfig));
app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// One JSON line per completed request (method, path, status, ms,
// user when authenticated). Zero-dep stand-in for morgan.
app.use(require("./middleware/requestLogger"));

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
app.get("/api/v2/health/build", (req, res) => {
  res.json({
    status:        "ok",
    commitSha:     _BOOT_SHA,
    startedAt:     _BOOT_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node:          process.version,
    env:           process.env.NODE_ENV || "development",
    // Quick-look inventory so ops can grep for "running-eta" in the
    // response and confirm the route family is mounted *on this
    // process*. If these are missing, the deploy didn't pick up the
    // latest order router.
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

app.use("/api/v2/user", user);
app.use("/api/v2/machine",     ADMIN_GATE, machine);
app.use("/api/v2/shift",       shift);
app.use("/api/v2/customer",    ADMIN_GATE, customer);
app.use("/api/v2/employee",    ADMIN_GATE, employee);
app.use("/api/v2/elastic",     elastic);
app.use("/api/v2/dc",          ADMIN_GATE, deliveryChallanRouter);
app.use("/api/v2/supplier",    ADMIN_GATE, supplier);
app.use("/api/v2/bonus",       bonus);
app.use("/api/v2/order",       ADMIN_GATE, order);
app.use("/api/v2/materials",   ADMIN_GATE, material);
app.use("/api/v2/warping",     warping);
app.use("/api/v2/wastage",     wastage);
app.use("/api/v2/attendance",  attendence);
app.use("/api/v2/covering",    covering);
app.use("/api/v2/job",         ADMIN_GATE, job);
app.use("/api/v2/packing",     packing);
app.use("/api/v2/production",  ADMIN_GATE, production);
app.use("/api/v2/payroll",     payroll);
app.use("/api/v2/leave",       leave);
app.use("/api/v2/machine-issue", machineIssue);
app.use("/api/v2/announcement", announcement);
app.use("/api/v2/feedback",    feedback);
app.use("/api/v2/dashboard",   dashboard);
app.use("/api/v2/advisor",     advisor);
app.use("/api/v2/io",          io);

// ── Customer portal API (v3) ────────────────────────────────────
// Mounted unauthenticated at the router level — the portal auth
// middleware is applied per-router (login is public, /me is gated).
app.use("/api/v3/portal/auth", portalAuth);


app.use(ErrorHandler);

module.exports = app;
