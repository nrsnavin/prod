'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A WORKER'S OWN LOGIN CANNOT DO, AND A FEW THINGS NOBODY SHOULD
//
//  A worker's self-service login carries the role "production", the same
//  as a supervisor's, so the role gates let it through. Held here:
//
//    • closing or reopening a machine issue is the office's (staffOnly);
//      a worker still reports one and sees the list;
//    • stock counts are closed to an account without Materials — reads
//      as well as writes;
//    • an advance is an amount of money: more than zero, not absurd, and
//      never a 500 with a validation dump;
//    • who approved an advance, and who marked attendance, is whoever is
//      signed in — not a name sent in the request.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supervisor, books, worker, ravi, ALWAYS_ON;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookieFor(u)).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookieFor(u)).send(body),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'MachineIssue', 'Advance', 'Attendence', 'StockCount']) M[n] = require(`../../models/${n}.js`);
  ({ ALWAYS_ON } = require('../../utils/features'));
  ravi = await M.Employee.create({ name: 'Ravi', phoneNumber: '9100000001', department: 'weaving', role: 'operator' });
  admin = await M.User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await M.User.create({ name: 'Floor Lead', email: 'floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
  books = await M.User.create({ name: 'Books', email: 'books@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  worker = await M.User.create({
    name: 'Ravi', email: 'worker-ravi@workers.invalid', password: 'pass1234', role: 'production', department: 'production',
    employee: ravi._id, features: ALWAYS_ON,
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a machine issue', () => {
  let issue;
  beforeEach(async () => {
    await M.MachineIssue.deleteMany({});
    issue = await M.MachineIssue.create({
      machine: new mongoose.Types.ObjectId(), employee: ravi._id, title: 'Belt slipping', description: 'Slips under load', severity: 'medium',
    });
  });

  it('cannot be closed by a worker\'s own login — not even the one who raised it', async () => {
    const res = await as(worker).put(`/api/v2/machine-issue/${issue._id}/status`, { status: 'resolved', resolutionNotes: 'fixed it myself' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/office staff/);
    expect((await M.MachineIssue.findById(issue._id).lean()).status).toBe('open');
  });

  it('is still the worker\'s to see and to list', async () => {
    expect((await as(worker).get(`/api/v2/machine-issue/${issue._id}`)).status).toBe(200);
    expect((await as(worker).get('/api/v2/machine-issue')).status).toBe(200);
    expect((await as(worker).get(`/api/v2/machine-issue/employee/${ravi._id}`)).status).toBe(200);
  });

  it('CONTROL: a supervisor closes it, and is recorded as the one who did', async () => {
    const res = await as(supervisor).put(`/api/v2/machine-issue/${issue._id}/status`, { status: 'resolved', resolutionNotes: 'Belt replaced' });
    expect(res.status).toBe(200);
    const saved = await M.MachineIssue.findById(issue._id).lean();
    expect(saved.status).toBe('resolved');
    expect(String(saved.resolvedBy)).toBe(String(supervisor._id));
    expect(saved.resolutionNotes).toBe('Belt replaced');
  });

  it('takes notes as text, and an id that is one', async () => {
    const res = await as(supervisor).put(`/api/v2/machine-issue/${issue._id}/status`, { status: 'acknowledged', resolutionNotes: { nested: true } });
    expect(res.status).toBe(200);
    expect((await M.MachineIssue.findById(issue._id).lean()).resolutionNotes).toBe('');
    expect((await as(supervisor).put('/api/v2/machine-issue/not-an-id/status', { status: 'resolved' })).status).toBe(404);
  });
});

describe('stock counts', () => {
  it('are closed to an account without Materials — reading included', async () => {
    const noMaterials = await M.User.create({
      name: 'Planner', email: 'plan@t.co', password: 'pass1234', role: 'production', department: 'production',
      features: ['/jobs', '/machines'],
    });
    const res = await as(noMaterials).get('/api/v2/stock-counts');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/access to this feature/);
    // A worker's login has no Materials either.
    expect((await as(worker).get('/api/v2/stock-counts')).status).toBe(403);
  });

  it('CONTROL: open with Materials, and to an account that was never narrowed', async () => {
    const stores = await M.User.create({
      name: 'Stores', email: 'stores@t.co', password: 'pass1234', role: 'production', department: 'production',
      features: ['/materials'],
    });
    expect((await as(stores).get('/api/v2/stock-counts')).status).toBe(200);
    expect((await as(supervisor).get('/api/v2/stock-counts')).status).toBe(200);
  });
});

describe('a salary advance', () => {
  beforeEach(async () => { await M.Advance.deleteMany({}); });

  it('is an amount of money', async () => {
    for (const amount of [-500, '-500', 'abc', '12abc', 0.4, 1e9, Infinity, { $gt: 0 }, [5000]]) {
      const res = await as(worker).post('/api/v2/payroll/advance', { amount, reason: 'festival' });
      expect(res.status).toBe(400);
    }
    expect(await M.Advance.countDocuments({})).toBe(0);
  });

  it('asked for by a worker is theirs, pending, to the paisa', async () => {
    const res = await as(worker).post('/api/v2/payroll/advance', { amount: '5000.555', reason: `  ${'x'.repeat(900)}  ` });
    expect(res.status).toBe(200);
    const adv = await M.Advance.findOne({}).lean();
    expect(String(adv.employee)).toBe(String(ravi._id));
    expect(adv.amount).toBe(5000.56);
    expect(adv.status).toBe('requested');
    expect(adv.reason).toHaveLength(500);
  });

  it('is approved by whoever is signed in, whatever the request says', async () => {
    const adv = await M.Advance.create({ employee: ravi._id, amount: 4000 });
    const res = await as(books).put(`/api/v2/payroll/advance/${adv._id}/approve`, { deductMonth: 11, deductYear: 2026, approvedBy: 'The Owner' });
    expect(res.status).toBe(200);
    expect((await M.Advance.findById(adv._id).lean()).approvedBy).toBe('Books');
  });

  it('needs a real month to be recovered in, and a real id', async () => {
    const adv = await M.Advance.create({ employee: ravi._id, amount: 4000 });
    expect((await as(books).put(`/api/v2/payroll/advance/${adv._id}/approve`, { deductMonth: 13, deductYear: 2026 })).status).toBe(400);
    expect((await as(books).put('/api/v2/payroll/advance/nope/approve', { deductMonth: 11, deductYear: 2026 })).status).toBe(404);
    expect((await as(books).post('/api/v2/payroll/advance/admin-create', { employee: String(ravi._id), amount: -1, deductMonth: 11, deductYear: 2026 })).status).toBe(400);
    expect((await M.Advance.findById(adv._id).lean()).status).toBe('requested');
  });

  it('is not a worker\'s to approve', async () => {
    const adv = await M.Advance.create({ employee: ravi._id, amount: 4000 });
    expect((await as(worker).put(`/api/v2/payroll/advance/${adv._id}/approve`, { deductMonth: 11, deductYear: 2026 })).status).toBe(403);
  });

  it('the list takes a sane limit', async () => {
    await M.Advance.create({ employee: ravi._id, amount: 4000 });
    for (const limit of ['abc', '-5', '999999999']) {
      const res = await as(books).get(`/api/v2/payroll/advance?limit=${limit}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    }
    expect((await as(books).get('/api/v2/payroll/advance?employeeId=nope')).body.data).toEqual([]);
  });

  it('"pending" on the list means waiting for approval, which is what the admin app asks for', async () => {
    await M.Advance.create({ employee: ravi._id, amount: 4000 });                      // stored as requested
    await M.Advance.create({ employee: ravi._id, amount: 3000, status: 'pending' });   // an older request
    await M.Advance.create({ employee: ravi._id, amount: 2000, status: 'approved', deductMonth: 11, deductYear: 2026 });
    const res = await as(books).get('/api/v2/payroll/advance?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => a.amount).sort((a, b) => a - b)).toEqual([3000, 4000]);
    expect((await as(books).get('/api/v2/payroll/advance?status=requested')).body.data.map((a) => a.amount)).toEqual([4000]);
    expect((await as(books).get('/api/v2/payroll/advance?status=approved')).body.data.map((a) => a.amount)).toEqual([2000]);
  });
});

describe('attendance', () => {
  it('is marked by whoever is signed in, whatever the request says', async () => {
    await M.Attendence.deleteMany({});
    const res = await as(books).post('/api/v2/attendance/mark', {
      date: '2026-11-09', shift: 'DAY', markedBy: 'Somebody Else',
      records: [{ employeeId: String(ravi._id), status: 'present' }],
    });
    expect(res.status).toBe(200);
    const row = await M.Attendence.findOne({ employee: ravi._id }).lean();
    expect(row.markedBy).toBe('Books');

    const edit = await as(admin).put(`/api/v2/attendance/${row._id}`, { notes: 'came late', markedBy: 'Somebody Else' });
    expect(edit.status).toBe(200);
    expect((await M.Attendence.findById(row._id).lean()).markedBy).toBe('Owner');
  });
});

describe('the mail test', () => {
  it('is not sent for a link opened from another site, nor to something that is not one address', async () => {
    const cross = request(app).get('/api/v2/health/mailer?test=someone@example.com').set('Cookie', cookieFor(admin))
      .set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Mode', 'navigate').set('Sec-Fetch-Dest', 'document');
    const res = await cross;
    expect(res.status).toBe(200);
    expect(res.body.test).toMatchObject({ sent: false });
    expect(res.body.test.reason).toMatch(/another site/);

    for (const bad of ['a@b.co,c@d.co', 'no-at-sign', 'x@y.z <script>']) {
      const r = await as(admin).get(`/api/v2/health/mailer?test=${encodeURIComponent(bad)}`);
      expect(r.body.test).toMatchObject({ sent: false, reason: expect.stringMatching(/not one email address/) });
    }
  });
});

describe('the build probe', () => {
  it('lists the settings that put the system at risk, without their values', async () => {
    const res = await as(admin).get('/api/v2/health/build');
    expect(res.status).toBe(200);
    // The test key is short and guessable, which is exactly what it should say.
    const risk = res.body.security.risks.find((r) => r.key === 'JWT_SECRET_KEY');
    expect(risk).toMatchObject({ level: 'risk' });
    expect(JSON.stringify(res.body.security)).not.toContain(process.env.JWT_SECRET_KEY);
    // Not for anyone else.
    expect((await as(supervisor).get('/api/v2/health/build')).status).toBe(403);
  });
});

describe('the e-invoice provider\'s address', () => {
  const save = (baseUrl) => as(admin).put('/api/v2/settings/document', { invoice: { gsp: { provider: 'http-json', baseUrl } } });

  it('is refused unless it is https and outside this server\'s network', async () => {
    const plain = await save('http://gsp.example/api');
    expect(plain.status).toBe(400);
    expect(plain.body.message).toMatch(/E-invoice provider address: The address must start with https/);
    expect((await save('https://user:pw@gsp.example/api')).status).toBe(400);
    expect((await save('not a url')).status).toBe(400);
    expect((await save('https://gsp.example/api')).status).toBe(200);
  });

  it('one stored before the check is not called either, and says where to fix it', async () => {
    const DocumentSettings = require('../../models/DocumentSettings');
    await DocumentSettings.updateOne({ key: 'document' }, { $set: { 'invoice.gsp.provider': 'http-json', 'invoice.gsp.baseUrl': 'http://gsp.example/api' } }, { upsert: true });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    try {
      const provider = await require('../../services/einvoiceProvider').getProvider();
      await expect(provider.register({})).rejects.toMatchObject({ code: 'EINVOICE_NOT_CONFIGURED', message: expect.stringMatching(/Settings → Invoice cannot be used/) });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a provider that never answers is given up on, with a warning to check before retrying', async () => {
    const DocumentSettings = require('../../models/DocumentSettings');
    await DocumentSettings.updateOne({ key: 'document' }, { $set: { 'invoice.gsp.provider': 'http-json', 'invoice.gsp.baseUrl': 'https://gsp.example/api' } }, { upsert: true });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(timeout);
    try {
      const provider = await require('../../services/einvoiceProvider').getProvider();
      await expect(provider.register({})).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/did not answer in time.*may have gone through/) });
      // The call carries a time limit and follows no redirect with the credentials.
      const [, options] = fetchSpy.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe('error');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

