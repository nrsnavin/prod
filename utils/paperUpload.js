"use strict";
// ══════════════════════════════════════════════════════════════════
//  PAPERS SENT TO A READER — shared by the routes that take a photo or a
//  PDF and return a draft (api/accountsPapers.js, api/priceListRoutes.js).
//
//    paperUpload        multer in memory: up to 6 files of 12 MB
//    pagesOf(req)       the files as the readers take them
//    readFailure(err, what, next)
//                       a reader's failure in words a person can act on:
//                       no key on the server → 503 "type the details in";
//                       a refusal the service gave a status → that status;
//                       anything else → utils/docRead's own wording
// ══════════════════════════════════════════════════════════════════

const multer = require("multer");
const ErrorHandler = require("./ErrorHandler");

const paperUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 6 } });

const pagesOf = (req) => (Array.isArray(req.files) ? req.files : []).map((f) => ({ buffer: f.buffer, mimetype: f.mimetype }));

function readFailure(err, what, next) {
  if (err.code === "ANTHROPIC_KEY_MISSING") return next(new ErrorHandler(`Reading ${what} is not set up on this server: type the details in.`, 503));
  if (err.status) return next(new ErrorHandler(err.message, err.status));
  const f = require("./docRead").failure(err, what);
  return next(new ErrorHandler(f.message, f.status));
}

module.exports = { paperUpload, pagesOf, readFailure };
