'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE ERROR HANDLER ITSELF
//
//  Two things it got wrong about its own job.
//
//  It reported before it had decided. A stale form (409), an id that is
//  not one (400), an entry that already exists (400) and a session that
//  has ended (401) all arrive without a status, were given 500, written
//  to the error log with a stack and a reference — and only then turned
//  into the ordinary answer they are. So the log of server faults was
//  mostly people being told to reload, and its own comment said
//  otherwise.
//
//  And it could fail. "Already exists" names the field from the
//  database's error; an insert of several rows at once does not carry
//  one there, the handler threw, and Express's last-resort page answered
//  instead — which prints the stack and the server's file paths unless
//  NODE_ENV is exactly "production", and this server runs as
//  "PRODUCTION".
// ══════════════════════════════════════════════════════════════════

jest.mock('../../utils/errorReporter', () => ({ reportError: jest.fn() }));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const errorHandler = require('../../middleware/error');
const ErrorHandler = require('../../utils/ErrorHandler');
const { reportError } = require('../../utils/errorReporter');

function failing(make) {
  const app = express();
  app.get('/x', (req, res, next) => next(make()));
  app.use(errorHandler);
  return request(app).get('/x');
}

beforeEach(() => reportError.mockClear());

describe('an answer that is the caller\'s to act on is not a server fault', () => {
  const ordinary = [
    ['a form saved over a newer copy', () => new mongoose.Error.VersionError({ _doc: { _id: 1 } }, 3, ['qty']), 409],
    ['a conditional save that found the record changed', () => Object.assign(new Error('No document found'), { name: 'DocumentNotFoundError' }), 409],
    ['an id that is not one', () => new mongoose.Error.CastError('ObjectId', 'zzz', '_id'), 400],
    ['an entry that already exists', () => Object.assign(new Error('E11000 duplicate key error'), { name: 'MongoServerError', code: 11000, keyValue: { email: 'a@b.in' } }), 400],
    ['a session token that does not verify', () => { try { jwt.verify('abc', 'k'); } catch (e) { return e; } return null; }, 401],
    ['a session token that has run out', () => new jwt.TokenExpiredError('jwt expired', new Date()), 401],
  ];

  it.each(ordinary)('%s', async (_what, make, status) => {
    const res = await failing(make);
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    expect(res.body.ref).toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a read the database gave up on is still reported, once, under the reference shown', async () => {
    const res = await failing(() => Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50, codeName: 'MaxTimeMSExpired' }));
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/took too long/);
    expect(res.body.ref).toMatch(/^[0-9A-F]{8}$/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0].message).toBe('operation exceeded time limit');
    expect(reportError.mock.calls[0][2]).toBe(res.body.ref);
  });

  it('a 500 a route states on purpose is still reported', async () => {
    const res = await failing(() => new ErrorHandler('The bank file could not be written', 500));
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('The bank file could not be written');
    expect(res.body.ref).toMatch(/^[0-9A-F]{8}$/);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe('"already exists", from a save of several rows at once', () => {
  const bulk = (first) => Object.assign(
    new Error('E11000 duplicate key error collection: jarvis.shiftdetails index: date_1_shift_1_machine_1 dup key'),
    { name: 'MongoBulkWriteError', code: 11000, writeErrors: first ? [first] : [] },
  );

  it('is answered, not crashed on', async () => {
    const res = await failing(() => bulk());
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/already/i);
    // Nothing of the database's own words, and no stack.
    expect(JSON.stringify(res.body)).not.toMatch(/E11000|jarvis|index|at .*\.js/);
  });

  it('names the field when the first refused row says which', async () => {
    const res = await failing(() => bulk({ err: { code: 11000, keyValue: { machine: 'L-12', shift: 'DAY' } } }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Duplicate key machine,shift Entered');
  });

  it('a single save reads as it always did', async () => {
    const res = await failing(() => Object.assign(new Error('E11000'), { name: 'MongoServerError', code: 11000, keyValue: { email: 'a@b.in' } }));
    expect(res.body.message).toBe('Duplicate key email Entered');
  });
});

describe('when the handler itself meets something it did not expect', () => {
  it('answers in JSON with a reference, and never with a stack', async () => {
    // An error whose own fields cannot be read.
    const odd = () => {
      const e = new Error('inner detail that must not be shown');
      Object.defineProperty(e, 'details', { get() { throw new TypeError('reading details failed in /srv/app/secret.js'); } });
      e.code = 'SOMETHING';
      e.statusCode = 400;
      return e;
    };
    const res = await failing(odd);
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.code).toBe('SERVER_ERROR');
    expect(res.body.ref).toMatch(/^[0-9A-F]{8}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/secret\.js|reading details|inner detail/);
    expect(reportError).toHaveBeenCalled();
  });
});
