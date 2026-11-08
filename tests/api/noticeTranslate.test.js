'use strict';
// ══════════════════════════════════════════════════════════════════
//  NOTICES IN THE WORKERS' LANGUAGES
//
//  Put into Tamil and Hindi when posted; a worker gets their language,
//  English when it is not there; an admin's correction is theirs until
//  the English itself changes.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

let mongo, app, admin, worker, A;
const as = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const translated = (n = '') => ({ usage: {}, content: [{ type: 'text', text: JSON.stringify({ ta: { title: `பாதுகாப்பு பயிற்சி${n}`, body: 'வெள்ளிக்கிழமை மாலை 4 மணிக்கு' }, hi: { title: `सुरक्षा अभ्यास${n}`, body: 'शुक्रवार शाम 4 बजे' } }) }] });
const until = async (fn) => { for (let i = 0; i < 50; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  A = require('../../models/Announcement');
  const User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'nt@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  worker = await User.create({ name: 'Ravi', email: 'nt2@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => mockCreate.mockReset());

describe('a notice in the workers\' languages', () => {
  let id;
  it('is put into Tamil and Hindi when posted, without holding up the post', async () => {
    mockCreate.mockResolvedValueOnce(translated());
    const res = await request(app).post('/api/v2/announcement').set('Cookie', as(admin)).send({ title: 'Safety drill', body: 'Friday at 4 pm' });
    expect(res.status).toBe(201);
    id = res.body.data._id;
    const doc = await until(async () => { const d = await A.findById(id).lean(); return d.translations?.ta?.title ? d : null; });
    expect(doc.translations.ta).toMatchObject({ title: 'பாதுகாப்பு பயிற்சி', by: 'ai' });
    expect(doc.translations.hi.title).toBe('सुरक्षा अभ्यास');
  });

  it('reaches a worker in Tamil, with the English kept alongside', async () => {
    const res = await request(app).get('/api/v2/announcement/active?dept=production&lang=ta').set('Cookie', as(worker));
    const n = res.body.data.find((x) => x._id === id);
    expect(n).toMatchObject({ title: 'பாதுகாப்பு பயிற்சி', lang: 'ta', original: { title: 'Safety drill' } });
  });

  it('follows the phone\'s language when the app sends it as a header', async () => {
    const res = await request(app).get('/api/v2/announcement/active?dept=production').set('Cookie', as(worker)).set('Accept-Language', 'hi-IN,hi;q=0.9');
    expect(res.body.data.find((x) => x._id === id).title).toBe('सुरक्षा अभ्यास');
  });

  it('stays English for anyone who has not asked otherwise', async () => {
    const res = await request(app).get('/api/v2/announcement/active?dept=production').set('Cookie', as(worker));
    expect(res.body.data.find((x) => x._id === id)).toMatchObject({ title: 'Safety drill', lang: 'en' });
  });

  it('keeps an admin\'s correction when translated again', async () => {
    await request(app).put(`/api/v2/announcement/${id}`).set('Cookie', as(admin)).send({ translations: { ta: { title: 'பாதுகாப்பு ஒத்திகை', body: 'வெள்ளி மாலை 4 மணி' } } });
    mockCreate.mockResolvedValueOnce(translated(' 2'));
    const res = await request(app).post(`/api/v2/announcement/${id}/translate`).set('Cookie', as(admin));
    expect(res.body.data.translations.ta).toMatchObject({ title: 'பாதுகாப்பு ஒத்திகை', by: 'person' });
    expect(res.body.data.translations.hi.title).toBe('सुरक्षा अभ्यास 2');
  });

  it('redoes every language when the English changes', async () => {
    mockCreate.mockResolvedValueOnce(translated(' 3'));
    await request(app).put(`/api/v2/announcement/${id}`).set('Cookie', as(admin)).send({ body: 'Friday at 5 pm' });
    const doc = await until(async () => { const d = await A.findById(id).lean(); return d.translations?.ta?.title === 'பாதுகாப்பு பயிற்சி 3' ? d : null; });
    expect(doc.translations.ta.by).toBe('ai');
  });

  it('asks for both a title and a body in a correction', async () => {
    const res = await request(app).put(`/api/v2/announcement/${id}`).set('Cookie', as(admin)).send({ translations: { hi: { title: 'x' } } });
    expect(res.status).toBe(400);
  });
});
