'use strict';
// ══════════════════════════════════════════════════════════════════
//  A REQUEST ANOTHER SITE'S PAGE MAKES FROM SOMEONE'S BROWSER
//
//  The session cookie goes with it. CORS refuses a request that names a
//  foreign Origin; an <img> or a hidden frame names none. Browsers say
//  where a request came from in Sec-Fetch-Site, and middleware/
//  crossSite.js acts on it. Held here: what is refused, and — as
//  important — everything that must keep passing untouched.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = 'https://erp.example.com';

const request = require('supertest');
const express = require('express');
const { crossSiteGuard, originOf } = require('../../middleware/crossSite');

const ALLOWED = new Set(['https://erp.example.com']);
function probe() {
  const app = express();
  app.use(crossSiteGuard((o) => ALLOWED.has(o)));
  app.all('*', (req, res) => res.json({ ok: true, fromAnotherSite: req.fromAnotherSite === true }));
  return app;
}
const send = (method, headers = {}) => {
  const r = request(probe())[method]('/api/v2/anything');
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r;
};

describe('refused', () => {
  it('an image, script or frame on another site', async () => {
    for (const [mode, dest] of [['no-cors', 'image'], ['no-cors', 'script'], ['navigate', 'iframe'], ['no-cors', 'empty']]) {
      const res = await send('get', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': mode, 'Sec-Fetch-Dest': dest });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CROSS_SITE');
    }
  });

  it('anything that is not a GET, however it was sent — a form, a fetch', async () => {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await send(method, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
      expect(res.status).toBe(403);
    }
  });

  it('a site that is not on the list, by Origin or by Referer', async () => {
    expect((await send('post', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('get', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', Referer: 'https://evil.example/page' })).status).toBe(403);
    // A look-alike is not the same origin.
    expect((await send('post', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://erp.example.com.evil.example' })).status).toBe(403);
  });
});

describe('let through', () => {
  it('everything that does not say it is cross-site: the apps, cron, Twilio, the connector, older browsers', async () => {
    for (const method of ['get', 'post', 'put', 'delete']) expect((await send(method)).status).toBe(200);
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect((await send('post', { 'Sec-Fetch-Site': site })).status).toBe(200);
    }
  });

  it('a web app this server was told about, on another site', async () => {
    expect((await send('post', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://erp.example.com' })).status).toBe(200);
    // A link it opened in a new tab names no Origin; the Referer says where from.
    const res = await send('get', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Referer: 'https://erp.example.com/invoices/1' });
    expect(res.status).toBe(200);
    expect(res.body.fromAnotherSite).toBe(false);
  });

  it('a person opening a link — marked, so a GET that does more than read can decline', async () => {
    const res = await send('get', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    expect(res.status).toBe(200);
    expect(res.body.fromAnotherSite).toBe(true);
  });
});

describe('originOf', () => {
  it('is the origin of a URL, or nothing', () => {
    expect(originOf('https://erp.example.com/a/b?c=1')).toBe('https://erp.example.com');
    expect(originOf('http://localhost:5173/x')).toBe('http://localhost:5173');
    expect(originOf('not a url')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('in the app', () => {
  let app;
  beforeAll(() => { app = require('../../app.js'); });

  it('guards the API and leaves the published report files alone', async () => {
    const cross = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' };
    const api = request(app).get('/api/v2/health');
    for (const [k, v] of Object.entries(cross)) api.set(k, v);
    expect((await api).status).toBe(403);

    // /public is fetched by WhatsApp's servers and opened from chats.
    const file = request(app).get('/public/nothing-here.pdf');
    for (const [k, v] of Object.entries(cross)) file.set(k, v);
    expect((await file).status).toBe(404);

    expect((await request(app).get('/api/v2/health')).status).toBe(200);
  });

  it('the allow-list is the CORS one', async () => {
    const ok = await request(app).get('/api/v2/health').set('Sec-Fetch-Site', 'cross-site').set('Origin', 'https://erp.example.com');
    expect(ok.status).toBe(200);
  });
});
