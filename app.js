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


app.use("/api/v2/employee", (req, res, next) => {
  console.log("emp route hit");

  next()
}, employee);



// config
if (process.env.NODE_ENV !== "PRODUCTION") {
  require("dotenv").config({
    path: ".env",
  });
}


// it's for ErrorHandling
app.use(ErrorHandler);

module.exports = app;