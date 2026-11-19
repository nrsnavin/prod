'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE COMPANY'S OWN GSTIN
//
//  Found reading api/settings.js line by line.
//
//  Every customer's and supplier's GSTIN is checked when it is typed.
//  The company's own — printed on every invoice, sent with every
//  e-invoice, and the number the state of supply is read from — was
//  saved as typed: "33ABCDE1234F1Z" (one short), a number with a space
//  in it, or small letters, and the first anyone knew was the e-invoice
//  portal refusing an invoice.
//
//  It is checked when it CHANGES. The settings form sends every field
//  with each save, so a number on file from before this check must not
//  stop the footer note being edited.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, DocumentSettings, admin;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const save = (body) => request(app).put('/api/v2/settings/document').set('Cookie', cookieFor(admin)).send(body);
const stored = async () => (await DocumentSettings.findOne({ key: 'document' }).lean()) || {};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  DocumentSettings = require('../../models/DocumentSettings.js');
  const User = require('../../models/User.js');
  admin = await User.create({ name: 'Owner', email: 'gst-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  await DocumentSettings.deleteMany({});
  require('../../services/documentSettings.js').invalidate();
});

describe('saving the company GSTIN', () => {
  it('refuses a number that is not a GSTIN, and keeps the one on file', async () => {
    expect((await save({ gstin: '33ABCDE1234F1Z5' })).status).toBe(200);

    for (const wrong of ['33ABCDE1234F1Z', '33ABCDE 1234F1Z5', 'ABCDE1234F', '33ABCDE1234F1Z55', 'not applicable']) {
      const res = await save({ gstin: wrong, footerNote: 'Thank you' });
      // Before: 200, and that was the number on the next invoice.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/GSTIN/);
      expect(res.body.message).toMatch(/15/);
    }
    const kept = await stored();
    expect(kept.gstin).toBe('33ABCDE1234F1Z5');
    // Nothing else in a refused save is kept either.
    expect(kept.footerNote || '').not.toBe('Thank you');
  });

  it('keeps it trimmed and in capitals', async () => {
    const res = await save({ gstin: '  33abcde1234f1z5 ' });
    expect(res.status).toBe(200);
    // Before: "33abcde1234f1z5" — which the e-invoice portal does not know.
    expect(res.body.settings.gstin).toBe('33ABCDE1234F1Z5');
    expect((await stored()).gstin).toBe('33ABCDE1234F1Z5');
  });

  it('can be left empty: not every business is registered (unchanged)', async () => {
    expect((await save({ gstin: '33ABCDE1234F1Z5' })).status).toBe(200);
    const res = await save({ gstin: '' });
    expect(res.status).toBe(200);
    expect((await stored()).gstin).toBe('');
  });

  it('does not stop another field being saved when the number on file was never one', async () => {
    // On file from before the check.
    await DocumentSettings.collection.insertOne({ key: 'document', companyName: 'Balu Elastics', gstin: 'TO BE ADDED' });
    require('../../services/documentSettings.js').invalidate();

    // The form sends every field with each save.
    const res = await save({ gstin: 'TO BE ADDED', footerNote: 'Goods once sold are not taken back' });
    expect(res.status).toBe(200);
    const kept = await stored();
    expect(kept.footerNote).toBe('Goods once sold are not taken back');
    expect(kept.gstin).toBe('TO BE ADDED');

    // Changing it to another wrong number is still refused…
    expect((await save({ gstin: 'STILL NOT ONE' })).status).toBe(400);
    // …and putting the right one in works.
    expect((await save({ gstin: '33ABCDE1234F1Z5' })).status).toBe(200);
    expect((await stored()).gstin).toBe('33ABCDE1234F1Z5');
  });

  it('saves the other fields as before when no GSTIN is sent (unchanged)', async () => {
    const res = await save({ companyName: 'Balu Elastics Pvt Ltd', accentColor: '#1D6FEB' });
    expect(res.status).toBe(200);
    expect(res.body.settings.companyName).toBe('Balu Elastics Pvt Ltd');
  });
});
