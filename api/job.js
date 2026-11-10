'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS  —  /api/v2/job
//
//  This file makes the router and requires a signed-in user for all of
//  it. The routes live in the files mounted below, each a run of
//  related routes:
//
//    jobPlanning.js   raise a job, the lists, its detail, plan weaving
//    jobElastics.js   the elastics a job makes, and changing one mid-run
//    jobProgress.js   status, weaving readiness, cancel, wastage
//    jobMachines.js   summary, operators, checking, assigning a machine
//    jobLookup.js     a scanned number, stale jobs, wastage outliers,
//                     and the phone's detail at /:jobId
//    jobMaterials.js  outsourcing, production mode, lots, MRP and POs
//
//  jobShared.js holds the helpers more than one of them uses.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const { isAuthenticated } = require('../middleware/auth');
// Loaded for the models they register: the routes populate references
// to them by name.
require('../models/RawMaterial');
require('../models/Elastic');
const router = express.Router();

// Every job route requires a logged-in user. The previous setup left
// the whole router anonymous, including the alternate `/:jobId`
// detail at the bottom of the file and the machine-assign / stage-
// transition mutations.
router.use(isAuthenticated);

// The routes, in the order they were written. Express tries a router's
// routes in the order they were added, and a router mounted with use()
// is tried in place, so these files answer exactly as one file would.
// That makes the order matter: a new route is tried after everything
// above it and before everything below it, across files. Check it
// neither hides nor is hidden by another — GET /:id hides any
// one-segment GET path below it.
router.use(require("./jobPlanning"));
router.use(require("./jobElastics"));
router.use(require("./jobProgress"));
router.use(require("./jobMachines"));
router.use(require("./jobLookup"));
router.use(require("./jobMaterials"));

module.exports = router;
