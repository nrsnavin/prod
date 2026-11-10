'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A FAILURE TELLS THE PERSON ON THE SCREEN
//
//  Whatever went wrong was sent out in its own words. For a rule a route
//  states on purpose that is right. For a crash it is not: a programming
//  error helps nobody, and a driver's or the network's complaint names
//  hosts and fields. And sixty-six handlers answered their own failures,
//  past the central handler: a bad id was a 500, and nothing was
//  reported or logged.
//
//  Held here: an internal fault is answered with one sentence and a
//  reference, the reference is on the log line with the real error, and
//  everything a route says on purpose still arrives as it was said.
// ══════════════════════════════════════════════════════════════════

jest.mock('../../utils/errorReporter', () => ({ reportError: jest.fn() }));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const errorHandler = require('../../middleware/error');
const ErrorHandler = require('../../utils/ErrorHandler');
const { sendError } = require('../../utils/routeError');
const { reportError } = require('../../utils/errorReporter');

/** A one-route app that fails with `make()`. */
function failing(make, { own = false, fallback } = {}) {
  const app = express();
  app.get('/x', (req, res, next) => {
    const err = make();
    if (own) return sendError(req, res, err, fallback);
    return next(err);
  });
  app.use(errorHandler);
  return request(app).get('/x');
}

beforeEach(() => reportError.mockClear());

describe('an internal fault', () => {
  const faults = [
    ['a programming error', () => new TypeError("Cannot read properties of undefined (reading 'gstin')")],
    ['a reference to nothing', () => new ReferenceError('invoiceTotl is not defined')],
    ['the database being unreachable', () => Object.assign(new Error('connect ECONNREFUSED 10.0.1.5:27017'), { code: 'ECONNREFUSED', syscall: 'connect' })],
    ['the database driver', () => Object.assign(new Error('E11001 PlanExecutor error during aggregation :: caused by :: index customer_1_gstin_1'), { name: 'MongoServerError', code: 292 })],
    ['a network name that does not resolve', () => Object.assign(new Error('getaddrinfo ENOTFOUND cluster0.ftoq7bw.mongodb.net'), { code: 'ENOTFOUND' })],
    ['a header Node refused', () => Object.assign(new TypeError('Invalid character in header content ["Content-Disposition"]'), { code: 'ERR_INVALID_CHAR' })],
  ];

  it.each(faults)('%s is not read out', async (_what, make) => {
    const res = await failing(make);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');
    expect(res.body.ref).toMatch(/^[0-9A-F]{8}$/);
    expect(res.body.message).toContain(res.body.ref);
    expect(res.body.message).toMatch(/Something went wrong on the server/);
    // Nothing of the fault itself.
    const own = make().message;
    for (const piece of own.split(/[\s():]+/).filter((w) => w.length > 5)) expect(JSON.stringify(res.body)).not.toContain(piece);
  });

  it('is on the log with the reference the person was shown', async () => {
    const res = await failing(() => new TypeError('boom'));
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, , ref] = reportError.mock.calls[0];
    expect(err.message).toBe('boom');
    expect(ref).toBe(res.body.ref);
  });
});

describe('something said on purpose', () => {
  it('a route\'s own refusal arrives as it was said, whatever its status', async () => {
    for (const status of [400, 403, 404, 409, 422, 500, 502, 503]) {
      const res = await failing(() => new ErrorHandler('The provider did not answer in time.', status));
      expect(res.status).toBe(status);
      expect(res.body.message).toBe('The provider did not answer in time.');
    }
  });

  it('a route\'s code and details still travel with it', async () => {
    const res = await failing(() => Object.assign(new ErrorHandler('Not enough stock', 409), { code: 'INSUFFICIENT_STOCK', details: { short: 4 } }));
    expect(res.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { short: 4 }, message: 'Not enough stock' });
    expect(res.body.ref).toBeUndefined();
  });

  it('a plain error a service raised with words in it keeps them, with a reference', async () => {
    const res = await failing(() => new Error('No shift plan for that date'));
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('No shift plan for that date');
    expect(res.body.ref).toMatch(/^[0-9A-F]{8}$/);
  });

  it('CONTROL: a 4xx is not reported and carries no reference', async () => {
    const res = await failing(() => new ErrorHandler('Pick a customer', 400));
    expect(res.body.ref).toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('the caller\'s own mistakes are still theirs', () => {
  it('a bad id is a 400, not a fault', async () => {
    const res = await failing(() => new mongoose.Error.CastError('ObjectId', 'nope', '_id'));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid _id/);
  });

  it('a JSON body that does not parse is a 400 in the parser\'s words', async () => {
    const app = express();
    app.use(express.json());
    app.post('/x', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const res = await request(app).post('/x').set('Content-Type', 'application/json').send('{"a": ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBeUndefined();
  });

  it.each([
    ['LIMIT_FILE_SIZE', 413, /too large/],
    ['LIMIT_FILE_COUNT', 400, /Too many files/],
    ['LIMIT_UNEXPECTED_FILE', 400, /Too many files/],
    ['LIMIT_FIELD_COUNT', 400, /larger than this accepts/],
  ])('an upload over its limit (%s) is a %i, not a 500', async (code, status, words) => {
    const multer = require('multer');
    const res = await failing(() => new multer.MulterError(code));
    expect(res.status).toBe(status);
    expect(res.body.message).toMatch(words);
    expect(res.body.code).toBe(code);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('a handler that catches its own errors', () => {
  it('answers like every other: a bad id is a 400', async () => {
    const res = await failing(() => new mongoose.Error.CastError('ObjectId', 'nope', 'employee'), { own: true });
    expect(res.status).toBe(400);
  });

  it('a crash is reported, and not read out', async () => {
    const res = await failing(() => new TypeError("Cannot read properties of null (reading 'netPay')"), { own: true });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('netPay');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('says what it was doing, when it named that', async () => {
    const res = await failing(() => new Error('aggregate pipeline exploded at stage 3'), { own: true, fallback: 'Failed to build MRP' });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/^Failed to build MRP\. Try again/);
    expect(res.body.message).toContain(res.body.ref);
    expect(JSON.stringify(res.body)).not.toContain('pipeline');
    expect(reportError.mock.calls[0][0].message).toBe('aggregate pipeline exploded at stage 3');
  });

  it('a refusal raised on purpose inside it keeps its words and status, named or not', async () => {
    const res = await failing(() => new ErrorHandler('This job is already closed', 409), { own: true, fallback: 'Failed to build MRP' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This job is already closed');
  });

  it('copes with something thrown that is not an error', async () => {
    const res = await failing(() => 'just a string', { own: true });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('just a string');
  });
});

describe('no route answers a 500 by itself any more', () => {
  it('nothing in api/ writes res.status(500)', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../api');
    const found = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, f.name);
        if (f.isDirectory()) { walk(full); continue; }
        if (!f.name.endsWith('.js')) continue;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (/res\.status\(\s*500\s*\)/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`${path.relative(dir, full)}:${i + 1}`);
        });
      }
    })(dir);
    expect(found).toEqual([]);
  });
});
