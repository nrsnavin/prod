const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

// Resolve config/.env relative to THIS file, not process.cwd().
// nodemon (and `node index.js`) sometimes runs from a parent directory,
// in which case a bare "config/.env" path silently misses the file and
// PORT / MONGO_URL come back undefined.
if (process.env.NODE_ENV !== "PRODUCTION") {
  require("dotenv").config({
    path: path.resolve(__dirname, "config/.env"),
  });
}

// Register the global audit-fields plugin BEFORE any model is required.
// This adds createdBy/updatedBy + auto-populating pre-save hooks to every
// schema, so every action is fingerprinted to the authenticated user.
const auditFields = require("./models/plugins/auditFields.js");
mongoose.plugin(auditFields);

const ErrorHandler = require("./middleware/error.js");
const app = express();
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const cors = require("cors");
const { setUserContext } = require("./middleware/userContext.js");

const user     = require("./api/user.js");
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

const corsConfig = {
  origin: true,
  credentials: true,
};

app.use(cors(corsConfig));
app.options('*', cors(corsConfig));
app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// Optional auth: when the request has a valid JWT cookie, attach req.user
// AND run downstream middleware in a user-context store so schema hooks
// can stamp createdBy/updatedBy automatically. Doesn't block unauth routes.
app.use(setUserContext);


app.use("/api/v2/user", user);
app.use("/api/v2/machine", machine);
app.use("/api/v2/shift", shift);
app.use("/api/v2/customer", customer);
app.use("/api/v2/employee", employee);
app.use("/api/v2/elastic", elastic);
app.use("/api/v2/dc", deliveryChallanRouter);
app.use("/api/v2/supplier", supplier);
app.use("/api/v2/bonus", bonus);
app.use("/api/v2/order", order);
app.use("/api/v2/materials", material);
app.use("/api/v2/warping", warping);
app.use("/api/v2/wastage", wastage);
app.use("/api/v2/attendance", attendence);
app.use("/api/v2/covering", covering);
app.use("/api/v2/job", job);
app.use("/api/v2/packing", packing);
app.use("/api/v2/production", production);
app.use("/api/v2/payroll", payroll);
app.use("/api/v2/leave", leave);
app.use("/api/v2/machine-issue", machineIssue);
app.use("/api/v2/announcement", announcement);
app.use("/api/v2/feedback", feedback);


app.use(ErrorHandler);

module.exports = app;
