const express = require("express");
const ErrorHandler = require("./middleware/error.js");
const app = express();
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const cors = require("cors");




const user = require("./api/user.js")

const machine = require("./api/machine.js")

const shift = require("./api/shift.js")

const employee = require("./api/employee.js")

const customer = require("./api/customer.js")


const supplier = require("./api/supplier.js")


const material = require("./api/rawMaterial.js")

const elastic = require("./api/elastic.js")

const order = require("./api/order.js")
const job = require("./api/job.js")

const warping = require("./api/warping.js")

const covering = require("./api/covering.js")

const packing = require("./api/packing.js")



const corsConfig = {
  origin: true,
  credentials: true,
};

app.use(cors(corsConfig));
app.options('*', cors(corsConfig))
app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));


app.use("/api/v2/user", (req, res, next) => {
  console.log("Hi");

  next()
}, user);

app.use("/api/v2/machine", (req, res, next) => {
  console.log("machine route hit");

  next()
}, machine);


app.use("/api/v2/shift", (req, res, next) => {
  console.log("shift route hit");

  next()
}, shift);



app.use("/api/v2/customer", (req, res, next) => {
  console.log("customer route hit");

  next()
}, customer);

app.use("/api/v2/employee", (req, res, next) => {
  console.log("emp route hit");

  next()
}, employee);



app.use("/api/v2/elastic", (req, res, next) => {
  console.log("elastic route hit");

  next()
}, elastic);


app.use("/api/v2/supplier", (req, res, next) => {
  console.log("supplier route hit");

  next()
}, supplier);


app.use("/api/v2/order", (req, res, next) => {
  console.log("order route hit");

  next()
}, order);

app.use("/api/v2/materials", (req, res, next) => {
  console.log("material route hit");

  next()
}, material);


app.use("/api/v2/warping", (req, res, next) => {
  console.log("warping route hit");

  next()
}, warping);



app.use("/api/v2/covering", (req, res, next) => {
  console.log("covering route hit");

  next()
}, covering);


app.use("/api/v2/job", (req, res, next) => {
  console.log("job route hit");

  next()
}, job);



app.use("/api/v2/packing", (req, res, next) => {
  console.log("packing route hit");

  next()
}, packing);



// config
if (process.env.NODE_ENV !== "PRODUCTION") {
  require("dotenv").config({
    path: ".env",
  });
}


// it's for ErrorHandling
app.use(ErrorHandler);

module.exports = app;