'use strict';
// Small helpers the accounts routers share: dates from a request, a
// reason for a cancel, paging, the fingerprint of a write, and a
// transaction wrapper written for callbacks that may run twice.

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const { buildFingerprint, actorFromRequest } = require('../utils/fingerprint');

const MIN_REASON = 8;
const DAY = 86_400_000;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && /^[0-9a-fA-F]{24}$/.test(String(v || ''));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function readDate(value, label, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ErrorHandler(`${label} is not a date`, 400);
  return d;
}

function reasonFrom(req) {
  const reason = String(req.body?.reason || req.body?.auditReason || '').trim();
  if (reason.length < MIN_REASON) throw new ErrorHandler(`Give a reason (at least ${MIN_REASON} characters)`, 400);
  return reason;
}

const fp = (code, doc, req, meta) => buildFingerprint(code, { entityId: doc._id, actor: actorFromRequest(req), meta });

// withTransaction RETRIES the callback on a transient error, so every
// callback is written to run twice safely: documents are created
// inside it from plain data, and existing ones changed by updateOne.
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    session.endSession();
  }
}

function paging(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const range = {};
  const from = readDate(req.query.from, 'from');
  const to = readDate(req.query.to, 'to');
  if (from) range.$gte = from;
  if (to) range.$lte = new Date(to.getTime() + DAY - 1);
  return { page, limit, skip: (page - 1) * limit, range: from || to ? range : null };
}

module.exports = { MIN_REASON, DAY, isId, r2, readDate, reasonFrom, fp, withTxn, paging };
