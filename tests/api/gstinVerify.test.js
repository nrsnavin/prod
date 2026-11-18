'use strict';
// ══════════════════════════════════════════════════════════════════
//  "VERIFY" BESIDE THE GSTIN — the customer and supplier forms
//
//    POST /customer/gstin/:gstin/verify     POST /supplier/gstin/:gstin/verify
//    GET  /customer/gstin/:gstin/check      GET  /supplier/gstin/:gstin/check
//
//  The number is checked here first (pattern, check character) and only
//  then with the GST system, through whoever is connected in Settings →
//  Invoice: a GSTIN lookup service when one is named, else the e-invoice
//  provider (ClearTax, or a GSP proxy).
//
//    • a number that fails its own check character is never sent out
//    • with nobody connected the answer still says what the number itself
//      shows, and how to connect
//    • ClearTax: the address, the headers (token, product, our GSTIN), a
//      GET with no body; the answer fills the form
//    • the answer is kept: a second click within fifteen minutes asks
//      nobody; { fresh: true } asks again
//    • a cancelled registration says so
//    • "no such number" is only said when the provider's answer is about
//      the number — a refused token, a quota or an empty reply is a
//      failed check, and nothing is kept
//    • a lookup service is asked first when one is named, its key in a
//      header or in the address; its key never leaves the server
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, DocumentSettings, GstinCheck, owner, fetchMock;
const realFetch = global.fetch;

const OURS = '33AABCS5678K1ZZ';   // this mill's own GSTIN (Settings → Documents)
const GSTIN = '33AAECB1234F1ZC';  // the party being added
const OTHER = '29AAGCM9012L1Z3';

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const verify = (gstin = GSTIN, body = {}, { as = owner, base = 'customer' } = {}) =>
  request(app).post(`/api/v2/${base}/gstin/${gstin}/verify`).set('Cookie', cookie(as)).send(body);
const lastCheck = (gstin = GSTIN, { as = owner, base = 'customer' } = {}) =>
  request(app).get(`/api/v2/${base}/gstin/${gstin}/check`).set('Cookie', cookie(as));

const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const NIC = {
  Gstin: GSTIN, TradeName: 'Sunrise Garments', LegalName: 'SUNRISE GARMENTS PRIVATE LIMITED',
  AddrBnm: 'Sunrise Towers', AddrBno: '12/4', AddrFlno: '2nd Floor', AddrSt: 'Avinashi Road', AddrLoc: 'Tiruppur',
  StateCode: 33, AddrPncd: 641603, TxpType: 'REG', Status: 'ACT', BlkStatus: 'U', DtReg: '2017-07-01', DtDReg: '1900-01-01',
};
const PORTAL = {
  gstin: GSTIN, lgnm: 'SUNRISE GARMENTS PRIVATE LIMITED', tradeNam: 'Sunrise Garments', sts: 'Active', dty: 'Regular', rgdt: '01/07/2017', cxdt: '',
  pradr: { addr: { bno: '12/4', flno: '2nd Floor', bnm: 'Sunrise Towers', st: 'Avinashi Road', loc: 'Gandhi Nagar', dst: 'Tiruppur', city: '', stcd: 'Tamil Nadu', pncd: '641603' } },
};

/** Settings as they are kept: written straight to the record. */
const settings = (set) => DocumentSettings.findOneAndUpdate({ key: 'document' }, { $set: set, $setOnInsert: { key: 'document' } }, { upsert: true });
const connectClearTax = (over = {}) => settings({ gstin: OURS, 'invoice.gsp.provider': 'cleartax', 'invoice.gsp.clientSecret': 'ws-token-1', 'invoice.gsp.baseUrl': '', ...over });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  DocumentSettings = require('../../models/DocumentSettings.js');
  GstinCheck = require('../../models/GstinCheck.js');
}, 60_000);

afterAll(async () => { global.fetch = realFetch; await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  owner = await User.create({ name: 'Owner', email: 'owner@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
});
afterEach(async () => {
  await Promise.all([User.deleteMany({}), DocumentSettings.deleteMany({}), GstinCheck.deleteMany({})]);
});

describe('the check made here', () => {
  it('what is not a GSTIN is refused, and nobody is asked', async () => {
    await connectClearTax();
    const res = await verify('33AAECB1234F');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('That is not a GSTIN: 15 characters, like 33AAECS1234F1Z5.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a number whose last character does not fit is a typo: said, and not sent to the portal', async () => {
    await connectClearTax();
    const res = await verify('33AAECB1234F1Z5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, gstin: '33AAECB1234F1Z5', valid: true, checksumOk: false, stateCode: '33', stateName: 'Tamil Nadu', pan: 'AAECB1234F',
      portal: { checked: false, reason: 'checksum' }, fill: null,
    });
    expect(res.body.message).toMatch(/check for a typo\. It was not sent to the GST portal\.$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await GstinCheck.countDocuments()).toBe(0);
  });

  it('with nobody connected it still says what the number shows, and how to connect', async () => {
    const res = await verify(GSTIN.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gstin: GSTIN, checksumOk: true, portal: { checked: false, reason: 'not_connected' }, fill: null });
    expect(res.body.message).toBe(
      'The number is well-formed (Tamil Nadu, PAN AAECB1234F). Checking it with the GST portal needs a connection: ClearTax or a GSTIN lookup service, in Settings → Invoice.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a provider that is named but has no token yet is not a connection', async () => {
    await settings({ gstin: OURS, 'invoice.gsp.provider': 'cleartax' });
    const res = await verify();
    expect(res.body.portal).toEqual({ checked: false, reason: 'not_connected' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await lastCheck()).body.lookup).toEqual({ available: false, via: '' });
  });
});

describe('through ClearTax', () => {
  beforeEach(() => connectClearTax());

  it('asks ClearTax for the GSTIN\'s details with the token and our GSTIN, and the answer fills the form', async () => {
    fetchMock.mockResolvedValue(reply(NIC));
    const res = await verify();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.clear.in/einv/v1/govt/api/Master/gstin/${GSTIN}`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ accept: 'application/json', 'x-cleartax-auth-token': 'ws-token-1', 'x-cleartax-product': 'EInvoice', gstin: OURS });
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('error');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, gstin: GSTIN, valid: true, checksumOk: true, stateCode: '33', stateName: 'Tamil Nadu', pan: 'AAECB1234F',
      message: 'Active on the GST portal: SUNRISE GARMENTS PRIVATE LIMITED (trade name Sunrise Garments).',
      portal: {
        checked: true, found: true, fromCache: false, source: 'cleartax', via: 'ClearTax', checkedByName: 'Owner',
        status: 'active', statusText: 'Active', legalName: 'SUNRISE GARMENTS PRIVATE LIMITED', tradeName: 'Sunrise Garments',
        taxpayerType: 'Regular', composition: false, sez: false, registeredOn: '2017-07-01', cancelledOn: '', einvoiceBlocked: false,
        address: { line: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', city: 'Tiruppur', state: 'Tamil Nadu', stateCode: '33', pincode: '641603' },
      },
      fill: {
        name: 'Sunrise Garments', legalName: 'SUNRISE GARMENTS PRIVATE LIMITED', tradeName: 'Sunrise Garments',
        address: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', city: 'Tiruppur', pincode: '641603', stateCode: '33',
        fullAddress: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Tiruppur, Tamil Nadu - 641603',
        pan: 'AAECB1234F', gstRegistration: 'regular', sez: false,
      },
    });
    expect(new Date(res.body.portal.checkedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Kept: who checked, and what came back.
    const kept = await GstinCheck.findOne({ gstin: GSTIN }).lean();
    expect(kept).toMatchObject({ found: true, status: 'active', source: 'cleartax', checkedByName: 'Owner', legalName: 'SUNRISE GARMENTS PRIVATE LIMITED' });
    expect(String(kept.checkedBy)).toBe(String(owner._id));
  });

  it('goes to the sandbox when that is the address in Settings', async () => {
    await connectClearTax({ 'invoice.gsp.baseUrl': 'https://api-sandbox.clear.in/' });
    fetchMock.mockResolvedValue(reply({ Status: 1, Data: NIC }));
    const res = await verify();
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api-sandbox.clear.in/einv/v1/govt/api/Master/gstin/${GSTIN}`);
    expect(res.body.portal.found).toBe(true);
  });

  it('says our own GSTIN is missing rather than asking without it', async () => {
    await settings({ gstin: '' });
    const res = await verify();
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Your GSTIN is missing (Settings → Documents): ClearTax needs it.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a second click within fifteen minutes is answered from what was kept; fresh asks again', async () => {
    fetchMock.mockResolvedValue(reply(NIC));
    await verify();
    const again = await verify(GSTIN, {}, { base: 'supplier' }); // the other form, the same number
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.body.portal).toMatchObject({ checked: true, found: true, fromCache: true, status: 'active', checkedByName: 'Owner' });
    expect(again.body.fill.name).toBe('Sunrise Garments');

    fetchMock.mockResolvedValue(reply({ ...NIC, Status: 'SUS' }));
    const fresh = await verify(GSTIN, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh.body.portal).toMatchObject({ fromCache: false, status: 'suspended' });
    expect(await GstinCheck.countDocuments()).toBe(1); // one row per GSTIN, replaced
  });

  it('an answer older than fifteen minutes is asked again', async () => {
    fetchMock.mockResolvedValue(reply(NIC));
    await verify();
    await GstinCheck.updateOne({ gstin: GSTIN }, { $set: { checkedAt: new Date(Date.now() - 16 * 60 * 1000) } });
    const res = await verify();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.body.portal.fromCache).toBe(false);
  });

  it('a cancelled registration says so, and since when', async () => {
    fetchMock.mockResolvedValue(reply({ ...NIC, Status: 'CNL', DtDReg: '2024-03-12' }));
    const res = await verify();
    expect(res.body.portal).toMatchObject({ found: true, status: 'cancelled', statusText: 'Cancelled', cancelledOn: '2024-03-12' });
    expect(res.body.message).toBe(
      'Cancelled on the GST portal since 12 Mar 2024: SUNRISE GARMENTS PRIVATE LIMITED (trade name Sunrise Garments). It is no longer a registered party.'
    );
  });

  it('a composition dealer and a blocked e-invoice flag come through', async () => {
    fetchMock.mockResolvedValue(reply({ ...NIC, TxpType: 'COM', BlkStatus: 'B' }));
    const res = await verify();
    expect(res.body.portal).toMatchObject({ taxpayerType: 'Composition', composition: true, einvoiceBlocked: true });
    expect(res.body.fill.gstRegistration).toBe('composition');
  });

  it('"no such number" in the provider\'s own words: kept, and nothing to fill', async () => {
    fetchMock.mockResolvedValue(reply({ Status: 0, ErrorDetails: [{ ErrorCode: '3001', ErrorMessage: 'Requested data is not available' }], Data: null }, 400));
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.portal).toMatchObject({ checked: true, found: false, said: '3001: Requested data is not available', status: 'unknown' });
    expect(res.body.fill).toBeNull();
    expect(res.body.message).toBe(`No registration came back for ${GSTIN} from the GST portal — it said: 3001: Requested data is not available.`);
    expect(await GstinCheck.findOne({ gstin: GSTIN }).lean()).toMatchObject({ found: false, said: '3001: Requested data is not available', legalName: '' });

    // …and a later answer that finds it replaces that.
    fetchMock.mockResolvedValue(reply(NIC));
    const later = await verify(GSTIN, { fresh: true });
    expect(later.body.portal).toMatchObject({ found: true, said: '', status: 'active' });
  });

  it('reads "not found" however a provider words it', async () => {
    const bodies = [
      { success: false, message: 'Invalid GSTIN' },
      { error: { error_cd: 'FO8000', message: 'No records found' } },
      { errors: [{ error_code: '3028', error_message: 'GSTIN is invalid' }] },
      { message: 'The GSTIN passed in the request is not available' },
      { status_desc: 'GSTIN does not exist' },
    ];
    for (const body of bodies) {
      fetchMock.mockResolvedValue(reply(body, 200));
      const res = await verify(GSTIN, { fresh: true });
      expect(res.status).toBe(200);
      expect(res.body.portal.found).toBe(false);
      expect(res.body.fill).toBeNull();
    }
  });

  it('a refused token is a failed check, not "no such number" — and nothing is kept', async () => {
    fetchMock.mockResolvedValue(reply({ errors: [{ error_code: '1005', error_message: 'Invalid Token' }] }, 401));
    const res = await verify();
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('ClearTax refused the GSTIN lookup (401): 1005: Invalid Token. Check the connection in Settings → Invoice.');
    expect(await GstinCheck.countDocuments()).toBe(0);
  });

  it('words about the call and not the number are a failed check too, whatever the status', async () => {
    for (const [body, status, want] of [
      [{ errors: [{ error_code: '1005', error_message: 'Invalid Token' }] }, 200, 'ClearTax did not look the GSTIN up: 1005: Invalid Token'],
      [{ message: 'User GSTIN is not registered with ClearTax for e-invoicing' }, 400, 'ClearTax did not look the GSTIN up (400): User GSTIN is not registered with ClearTax for e-invoicing'],
      [{ message: 'Not Found' }, 404, 'ClearTax did not look the GSTIN up (404): Not Found'],
    ]) {
      fetchMock.mockResolvedValue(reply(body, status));
      const res = await verify();
      expect(res.status).toBe(502);
      expect(res.body.message).toBe(want);
    }
    expect(await GstinCheck.countDocuments()).toBe(0);
  });

  it('too many lookups, a provider fault, and no lookup on this connection each say what happened', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'Rate limit exceeded' }, 429));
    expect((await verify()).body.message).toBe('ClearTax is taking no more GSTIN lookups for now: Rate limit exceeded. Try again later.');

    fetchMock.mockResolvedValue(reply({}, 503));
    expect((await verify()).body.message).toBe('ClearTax could not look the GSTIN up just now (503). Try again in a minute.');

    fetchMock.mockResolvedValue(reply({}, 404));
    const none = await verify();
    expect(none.status).toBe(502);
    expect(none.body.message).toBe('ClearTax has no GSTIN lookup on this connection (404). A GSTIN lookup service can be named in Settings → Invoice instead.');

    fetchMock.mockResolvedValue(reply({}, 200));
    expect((await verify()).body.message).toBe('ClearTax sent back nothing that reads as a GST registration. Nothing was filled in.');
    expect(await GstinCheck.countDocuments()).toBe(0);
  });

  it('a reply that announces itself as megabytes is not read as a registration', async () => {
    await settings({ 'invoice.gstinLookup.url': 'https://lookup.example.com/{gstin}' });
    const json = jest.fn(async () => NIC);
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(5 * 1024 * 1024) : null) }, json });
    const res = await verify();
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('The GSTIN lookup service sent back far more than a registration. Check its address in Settings → Invoice.');
    expect(json).not.toHaveBeenCalled();
    expect(await GstinCheck.countDocuments()).toBe(0);
  });

  it('an answer about a different GSTIN fills nothing', async () => {
    fetchMock.mockResolvedValue(reply({ ...NIC, Gstin: OTHER }));
    const res = await verify();
    expect(res.status).toBe(502);
    expect(res.body.message).toBe(`ClearTax answered about ${OTHER}, not ${GSTIN}. Nothing was filled in.`);
    expect(await GstinCheck.countDocuments()).toBe(0);
  });

  it('no answer in time, or no connection, is said as that', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const slow = await verify();
    expect(slow.status).toBe(502);
    expect(slow.body.message).toBe('ClearTax did not answer in time. Try again in a minute.');

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect((await verify()).body.message).toBe('ClearTax could not be reached. Try again in a minute.');
  });

  it('the token goes to ClearTax only: another address left in Settings is not called', async () => {
    await connectClearTax({ 'invoice.gsp.baseUrl': 'https://gsp.example.com' });
    const res = await verify();
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('through a GSP proxy ("http-json")', () => {
  it('asks {its address}/gstin/{gstin} with its credentials', async () => {
    await settings({
      gstin: OURS, 'invoice.gsp.provider': 'http-json', 'invoice.gsp.baseUrl': 'https://gsp.example.com/api/', 'invoice.gsp.clientId': 'cid',
      'invoice.gsp.clientSecret': 'csecret', 'invoice.gsp.username': 'apiuser', 'invoice.gsp.password': 'apipass',
    });
    fetchMock.mockResolvedValue(reply({ Status: 1, Data: NIC }));
    const res = await verify();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://gsp.example.com/api/gstin/${GSTIN}`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ accept: 'application/json', 'client-id': 'cid', 'client-secret': 'csecret', username: 'apiuser', password: 'apipass', gstin: OURS });
    expect(init.body).toBeUndefined();
    expect(res.body.portal).toMatchObject({ found: true, source: 'http-json', via: 'your e-invoice provider' });
  });

  it('a proxy with no such route says a lookup service can be named instead', async () => {
    await settings({ gstin: OURS, 'invoice.gsp.provider': 'http-json', 'invoice.gsp.baseUrl': 'https://gsp.example.com', 'invoice.gsp.password': 'apipass' });
    fetchMock.mockResolvedValue(reply({}, 404));
    const res = await verify();
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Your e-invoice provider has no GSTIN lookup on this connection (404). A GSTIN lookup service can be named in Settings → Invoice instead.');
  });
});

describe('through a GSTIN lookup service named in Settings', () => {
  it('is asked first, at its address with {gstin} filled in and its key in the header named', async () => {
    await connectClearTax({
      'invoice.gstinLookup.url': 'https://lookup.example.com/v2/taxpayer/{gstin}?detail=full',
      'invoice.gstinLookup.headerName': 'x-api-key', 'invoice.gstinLookup.key': 'lk-secret-9',
    });
    fetchMock.mockResolvedValue(reply({ error: false, data: PORTAL }));
    const res = await verify();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://lookup.example.com/v2/taxpayer/${GSTIN}?detail=full`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ accept: 'application/json', 'x-api-key': 'lk-secret-9' });
    expect(init.redirect).toBe('error');

    expect(res.body.portal).toMatchObject({
      found: true, source: 'lookup', via: 'your GSTIN lookup service', status: 'active',
      address: { line: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', locality: 'Gandhi Nagar', city: 'Tiruppur', pincode: '641603' },
    });
    expect(res.body.fill).toMatchObject({ address: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Gandhi Nagar', city: 'Tiruppur', pincode: '641603', stateCode: '33' });
    // The key is nowhere in what the form is sent.
    expect(JSON.stringify(res.body)).not.toContain('lk-secret-9');
  });

  it('a service that takes the GSTIN as a query and its key in a header of its own naming', async () => {
    // As one such service documents its call: GET …/?gstin=…, header "passthrough".
    await settings({
      'invoice.gstinLookup.url': 'https://www.lookup.example.com/developers/gstincall/?gstin={gstin}',
      'invoice.gstinLookup.headerName': 'passthrough', 'invoice.gstinLookup.key': 'kyg-key-1',
    });
    fetchMock.mockResolvedValue(reply({
      status: 'Active', 'registration-date': '01/07/2017', gstin: GSTIN, 'dealer-type': 'Regular', 'trade-name': 'Sunrise Garments',
      'legal-name': 'SUNRISE GARMENTS PRIVATE LIMITED',
      adress: { bname: 'Sunrise Towers', street: 'Avinashi Road', bno: '12/4', location: 'Tiruppur', floor: '2nd Floor', state: 'Tamil Nadu', pincode: '641603' },
    }));
    const res = await verify();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://www.lookup.example.com/developers/gstincall/?gstin=${GSTIN}`);
    expect(init.headers).toEqual({ accept: 'application/json', passthrough: 'kyg-key-1' });
    expect(res.body.portal).toMatchObject({ found: true, status: 'active', taxpayerType: 'Regular', registeredOn: '2017-07-01' });
    expect(res.body.fill).toMatchObject({
      name: 'Sunrise Garments', address: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road', city: 'Tiruppur', pincode: '641603',
      fullAddress: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Tiruppur, Tamil Nadu - 641603',
    });
  });

  it('a bearer token goes in Authorization, as typed', async () => {
    await settings({ 'invoice.gstinLookup.url': 'https://lookup.example.com/v1/gstin/{gstin}', 'invoice.gstinLookup.headerName': 'Authorization', 'invoice.gstinLookup.key': 'Bearer tok-123' });
    fetchMock.mockResolvedValue(reply(PORTAL));
    await verify();
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ accept: 'application/json', Authorization: 'Bearer tok-123' });
  });

  it('puts the key in the address where the service wants it there', async () => {
    await settings({ 'invoice.gstinLookup.url': 'https://lookup.example.com/check/{key}/{gstin}', 'invoice.gstinLookup.key': 'k/1 2' });
    fetchMock.mockResolvedValue(reply(PORTAL));
    await verify();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://lookup.example.com/check/k%2F1%202/${GSTIN}`);
    expect(init.headers).toEqual({ accept: 'application/json' });
  });

  it('nothing at that address is said as that; a refusal names the service', async () => {
    await settings({ 'invoice.gstinLookup.url': 'https://lookup.example.com/{gstin}', 'invoice.gstinLookup.headerName': 'Authorization', 'invoice.gstinLookup.key': 'Bearer x' });
    fetchMock.mockResolvedValue(reply({}, 404));
    expect((await verify()).body.message).toBe('Nothing answers at the GSTIN lookup address in Settings → Invoice (404).');

    fetchMock.mockResolvedValue(reply({ message: 'API key expired' }, 403));
    expect((await verify()).body.message).toBe('Your GSTIN lookup service refused the GSTIN lookup (403): API key expired. Check the connection in Settings → Invoice.');

    fetchMock.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    expect((await verify()).body.message).toBe('The GSTIN lookup service did not answer in time. Try again in a minute.');
  });

  it('an address stored before the rules that would not pass them now is not called', async () => {
    await settings({ 'invoice.gstinLookup.url': 'http://lookup.example.com/{gstin}' });
    const res = await verify();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/^The GSTIN lookup address in Settings → Invoice cannot be used: /);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the kept answer, and who may ask', () => {
  it('GET …/check gives the last answer without asking anyone, and says whether Verify is connected', async () => {
    const before = await lastCheck();
    expect(before.body).toEqual({ success: true, check: null, lookup: { available: false, via: '' } });

    await connectClearTax();
    fetchMock.mockResolvedValue(reply(NIC));
    await verify();
    fetchMock.mockClear();

    for (const base of ['customer', 'supplier']) {
      const res = await lastCheck(GSTIN, { base });
      expect(res.status).toBe(200);
      expect(res.body.lookup).toEqual({ available: true, via: 'ClearTax' });
      expect(res.body.check).toMatchObject({
        gstin: GSTIN, message: 'Active on the GST portal: SUNRISE GARMENTS PRIVATE LIMITED (trade name Sunrise Garments).',
        portal: { checked: true, found: true, fromCache: true, status: 'active' }, fill: { name: 'Sunrise Garments' },
      });
    }
    expect((await lastCheck('nonsense')).body.check).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('works from the supplier form as from the customer form', async () => {
    await connectClearTax();
    fetchMock.mockResolvedValue(reply(NIC));
    const res = await verify(GSTIN, {}, { base: 'supplier' });
    expect(res.status).toBe(200);
    expect(res.body.fill).toMatchObject({ name: 'Sunrise Garments', gstRegistration: 'regular', fullAddress: '12/4, 2nd Floor, Sunrise Towers, Avinashi Road, Tiruppur, Tamil Nadu - 641603' });
  });

  it('needs a login, and the module the form belongs to', async () => {
    await connectClearTax();
    const anon = await request(app).post(`/api/v2/customer/gstin/${GSTIN}/verify`).send({});
    expect(anon.status).toBe(401);

    // Finance without Customers ticked: the supplier form is theirs, the customer form is not.
    const buyer = await User.create({ name: 'Buyer', email: 'buyer@t.co', password: 'pass1234', role: 'accounts', department: 'finance', features: ['/suppliers'] });
    fetchMock.mockResolvedValue(reply(NIC));
    expect((await verify(GSTIN, {}, { as: buyer, base: 'customer' })).status).toBe(403);
    expect((await lastCheck(GSTIN, { as: buyer, base: 'customer' })).status).toBe(403);
    expect((await verify(GSTIN, {}, { as: buyer, base: 'supplier' })).status).toBe(200);

    // The floor has neither.
    const weaver = await User.create({ name: 'Weaver', email: 'weaver@t.co', password: 'pass1234', role: 'production', department: 'production' });
    expect((await verify(GSTIN, {}, { as: weaver, base: 'supplier' })).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('one login is held to sixty checks an hour, across both forms; another login is not held up by it', async () => {
    await connectClearTax();
    fetchMock.mockResolvedValue(reply(NIC));
    for (let i = 0; i < 60; i++) {
      const res = await verify(GSTIN, {}, { base: i % 2 ? 'supplier' : 'customer' });
      expect(res.status).toBe(200);
    }
    const over = await verify();
    expect(over.status).toBe(429);
    expect(over.body.message).toBe('Too many GSTIN checks in the last hour. Type the details in, or try again later.');
    expect((await verify(GSTIN, {}, { base: 'supplier' })).status).toBe(429);
    // Reading the kept answer is not a check.
    expect((await lastCheck()).status).toBe(200);

    const second = await User.create({ name: 'Second', email: 'second@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
    expect((await verify(GSTIN, {}, { as: second })).status).toBe(200);
    // Sixty-one answers, one question to the provider: the rest came from the kept answer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe('Settings → Invoice: the GSTIN lookup service', () => {
  const save = (invoice, as = owner) => request(app).put('/api/v2/settings/document').set('Cookie', cookie(as)).send({ invoice });
  const read = (as = owner) => request(app).get('/api/v2/settings/document').set('Cookie', cookie(as));

  it('keeps the address, the header name and the key — and never sends the key back', async () => {
    const res = await save({ gstinLookup: { url: ' https://lookup.example.com/gst/{gstin} ', headerName: 'x-api-key', key: 'lk-secret-9' } });
    expect(res.status).toBe(200);
    expect(res.body.settings.invoice.gstinLookup).toEqual({ url: 'https://lookup.example.com/gst/{gstin}', headerName: 'x-api-key', keySet: true });
    expect(res.body.settings.invoice.gstinCheck).toEqual({ available: true, via: 'your GSTIN lookup service' });
    expect(JSON.stringify(res.body)).not.toContain('lk-secret-9');

    const got = await read();
    expect(got.body.settings.invoice.gstinLookup).toEqual({ url: 'https://lookup.example.com/gst/{gstin}', headerName: 'x-api-key', keySet: true });
    expect(JSON.stringify(got.body)).not.toContain('lk-secret-9');

    // …and it is what Verify then uses.
    fetchMock.mockResolvedValue(reply(PORTAL));
    await verify();
    expect(fetchMock.mock.calls[0][0]).toBe(`https://lookup.example.com/gst/${GSTIN}`);
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('lk-secret-9');
  });

  it('a blank key keeps the one stored; clearing the address forgets it', async () => {
    await save({ gstinLookup: { url: 'https://lookup.example.com/gst/{gstin}', headerName: 'x-api-key', key: 'lk-secret-9' } });
    const kept = await save({ gstinLookup: { url: 'https://lookup.example.com/v2/{gstin}', headerName: 'x-api-key', key: '' } });
    expect(kept.body.settings.invoice.gstinLookup).toEqual({ url: 'https://lookup.example.com/v2/{gstin}', headerName: 'x-api-key', keySet: true });

    const cleared = await save({ gstinLookup: { url: '', headerName: '' } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.settings.invoice.gstinLookup).toEqual({ url: '', headerName: '', keySet: false });
    expect(cleared.body.settings.invoice.gstinCheck).toEqual({ available: false, via: '' });
    const row = await DocumentSettings.findOne({ key: 'document' }).select('+invoice.gstinLookup.key').lean();
    expect(row.invoice.gstinLookup.key).toBe('');
  });

  it('says who Verify will ask as things stand', async () => {
    expect((await read()).body.settings.invoice.gstinCheck).toEqual({ available: false, via: '' });
    await connectClearTax();
    expect((await read()).body.settings.invoice.gstinCheck).toEqual({ available: true, via: 'ClearTax' });
    expect((await read()).body.settings.invoice.gstinLookup).toEqual({ url: '', headerName: '', keySet: false });
  });

  it('refuses an address without {gstin}, one that is not https, one inside, and a header that is not one', async () => {
    const bad = async (gstinLookup, want) => {
      const res = await save({ gstinLookup });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(want);
    };
    await bad({ url: 'https://lookup.example.com/gst' }, /^GSTIN lookup address: put \{gstin\} where the number goes/);
    await bad({ url: 'http://lookup.example.com/{gstin}' }, /^GSTIN lookup address: The address must start with https:\/\/$/);
    await bad({ url: 'https://user:pw@lookup.example.com/{gstin}' }, /^GSTIN lookup address: Leave the user name and password out of the address$/);
    await bad({ url: 'ftp://lookup.example.com/{gstin}' }, /^GSTIN lookup address: /);
    await bad({ url: 'https://lookup.example.com/{gstin}', headerName: 'x api key' }, /^GSTIN lookup key header: /);
    await bad({ url: 'https://lookup.example.com/{gstin}', headerName: 'Host' }, /^GSTIN lookup key header: /);
    await bad({ url: 'https://lookup.example.com/{gstin}', headerName: 'x-key\r\nx-evil: 1' }, /^GSTIN lookup key header: /);
    await bad({ url: 'https://lookup.example.com/{gstin}', headerName: 'x-api-key', key: 'abc\r\nx-evil: 1' }, /^GSTIN lookup key: one line/);
    const row = await DocumentSettings.findOne({ key: 'document' }).lean();
    expect(row?.invoice?.gstinLookup?.url || '').toBe('');
  });

  it('is an admin\'s to change', async () => {
    const clerk = await User.create({ name: 'Clerk', email: 'clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
    const res = await save({ gstinLookup: { url: 'https://lookup.example.com/{gstin}' } }, clerk);
    expect(res.status).toBe(403);
  });

  it('shows everyone but an admin only where the address points — a key pasted into it stays with the admin', async () => {
    // Pasted whole, key and all, instead of with {key} and the key field.
    await save({ gstinLookup: { url: 'https://lookup.example.com/v1/search?gstin={gstin}&api_key=PASTED-SECRET-77' } });
    const clerk = await User.create({ name: 'Clerk', email: 'clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
    const seen = await read(clerk);
    expect(seen.status).toBe(200);
    expect(seen.body.settings.invoice.gstinLookup).toEqual({ url: 'https://lookup.example.com/…', headerName: '', keySet: false });
    expect(seen.body.settings.invoice.gstinCheck).toEqual({ available: true, via: 'your GSTIN lookup service' });
    expect(JSON.stringify(seen.body)).not.toContain('PASTED-SECRET-77');
    // The admin, who typed it and can change it, sees it as it is.
    expect((await read()).body.settings.invoice.gstinLookup.url).toBe('https://lookup.example.com/v1/search?gstin={gstin}&api_key=PASTED-SECRET-77');
    // …and Verify still works for the clerk: the address is used on the server.
    fetchMock.mockResolvedValue(reply(PORTAL));
    const res = await verify(GSTIN, {}, { as: clerk });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://lookup.example.com/v1/search?gstin=${GSTIN}&api_key=PASTED-SECRET-77`);
    expect(JSON.stringify(res.body)).not.toContain('PASTED-SECRET-77');
  });
});
