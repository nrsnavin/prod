'use strict';
// Coverage for the READ side of per-user feature enforcement
// (requireFeatureRead in middleware/auth.js). Before this, a module NOT in
// a user's admin-granted feature list was fully hidden by the frontend
// nav/route guard, but its API never blocked GETs — only writes. Anyone
// who called the read routes directly (devtools, Postman, a crafted
// request) could still browse the whole module. This file proves the gap
// is closed while three carve-outs keep working: worker self-service
// reads (own payslip/leave/bonus/attendance), legitimate cross-feature
// reads on shared master-data routers, and elastic.js's deliberately open
// shop-floor stock lookups.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, Employee, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const createUser = async (body) => {
  const res = await request(app)
    .post('/api/v2/user/manage/create')
    .set('Cookie', adminCookie())
    .send(body);
  return res;
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Employee = require('../../models/Employee.js');
  admin = await User.create({ name: 'Owner', email: 'rg-owner@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('leaf-feature reads are blocked without the feature', () => {
  test('GET is 403 when the explicit feature list omits the module', async () => {
    const c = await createUser({
      name: 'NoWaste2', email: 'nowaste2@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // no /wastage
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  test('GET is allowed when the feature is present', async () => {
    const c = await createUser({
      name: 'YesWaste2', email: 'yeswaste2@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs', '/wastage'],
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('an explicitly empty feature list blocks reads too', async () => {
    const c = await createUser({
      name: 'EmptyReader', email: 'emptyreader@t.co', password: 'pass1234',
      department: 'production', features: [],
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  // ...but an account that never had a list configured (legacy logins,
  // the create-admin owner, the WhatsApp bot) still defers to the role
  // gate, which is what keeps this change from locking anyone out.
  test('an account with no feature list at all still reads', async () => {
    const legacy = await User.create({
      name: 'LegacyReader', email: 'legacyreader@t.co', password: 'pass1234',
      role: 'production', department: 'production',
    });
    expect(legacy.features).toBeUndefined();
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(legacy._id, 'production'));
    expect(res.status).not.toBe(403);
  });
});

describe('shared master-data reads', () => {
  test('a broader read-side key is honored (machine reads accepted via /jobs)', async () => {
    // machine's read-key list is ('/machines','/jobs','/machine-issues','/analytics') —
    // a user with only /jobs must still be able to read machine data.
    const c = await createUser({
      name: 'JobReader', email: 'jobreader@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],
    });
    const res = await request(app)
      .get('/api/v2/machine/get-machines')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('machine reads are blocked for a feature list with neither key', async () => {
    const c = await createUser({
      name: 'NoMachine', email: 'nomachine@t.co', password: 'pass1234',
      department: 'production', features: ['/wastage'],
    });
    const res = await request(app)
      .get('/api/v2/machine/get-machines')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  test('customer reads are blocked for a finance user without /customers, /orders or /elastic-groups', async () => {
    const c = await createUser({
      name: 'FinanceNoCust', email: 'financenocust@t.co', password: 'pass1234',
      department: 'finance', features: ['/suppliers'],
    });
    const res = await request(app)
      .get('/api/v2/customer/all-customers')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).toBe(403);
  });

  test('customer reads are allowed via the broader /orders read-key', async () => {
    const c = await createUser({
      name: 'FinanceOrders', email: 'financeorders@t.co', password: 'pass1234',
      department: 'finance', features: ['/orders'],
    });
    const res = await request(app)
      .get('/api/v2/customer/all-customers')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).not.toBe(403);
  });
});

// Cross-feature reads are PICKER calls — the Order form wants the customer
// list, Analytics wants the machine list. Granting that at router level
// also handed over the detail routes, so a user with only /orders could
// pull a customer's full record and their portal logins. Sharing is now
// per-path.
describe('a sibling feature gets the picker, not the whole module', () => {
  let ordersOnly;

  beforeAll(async () => {
    const c = await createUser({
      name: 'OrdersPicker', email: 'orderspicker@t.co', password: 'pass1234',
      department: 'finance', features: ['/orders'], // no /customers
    });
    ordersOnly = c.body.user.id;
  });

  test('CAN read the customer picker list (the Order form needs it)', async () => {
    const res = await request(app)
      .get('/api/v2/customer/all-customers')
      .set('Cookie', cookie(ordersOnly, 'accounts'));
    expect(res.status).not.toBe(403);
  });

  test('CANNOT read a customer\'s full record', async () => {
    const res = await request(app)
      .get('/api/v2/customer/customerDetail')
      .query({ id: new mongoose.Types.ObjectId().toString() })
      .set('Cookie', cookie(ordersOnly, 'accounts'));
    expect(res.status).toBe(403);
  });

  test('CANNOT read a customer\'s portal logins', async () => {
    const res = await request(app)
      .get(`/api/v2/customer/${new mongoose.Types.ObjectId()}/portal-users`)
      .set('Cookie', cookie(ordersOnly, 'accounts'));
    expect(res.status).toBe(403);
  });

  test('the owning feature still reads everything on the router', async () => {
    const c = await createUser({
      name: 'RealCustomers', email: 'realcustomers@t.co', password: 'pass1234',
      department: 'finance', features: ['/customers'],
    });
    for (const p of ['/api/v2/customer/all-customers', '/api/v2/customer/customerDetail']) {
      const res = await request(app).get(p).set('Cookie', cookie(c.body.user.id, 'accounts'));
      expect(res.status).not.toBe(403);
    }
  });

  test('the same split applies to machines: list yes, detail no', async () => {
    const c = await createUser({
      name: 'JobsPicker', email: 'jobspicker@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // no /machines
    });
    const list = await request(app)
      .get('/api/v2/machine/get-machines')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(list.status).not.toBe(403);

    const detail = await request(app)
      .get(`/api/v2/machine/${new mongoose.Types.ObjectId()}`)
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(detail.status).toBe(403);
  });
});

// The other half of the report: pages whose own feature IS granted were
// 403ing on a dependency the module genuinely needs.
describe('a granted module can reach the data its own screens need', () => {
  test('Elastics can load the raw-material catalogue for a new elastic', async () => {
    const c = await createUser({
      name: 'ElasticsOnly', email: 'elasticsonly@t.co', password: 'pass1234',
      department: 'finance', features: ['/elastics'],
    });
    const res = await request(app)
      .get('/api/v2/materials/materialForNewElastic')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).not.toBe(403);
  });

  test('Employees can load the pay summary card', async () => {
    const c = await createUser({
      name: 'EmployeesOnly', email: 'employeesonly@t.co', password: 'pass1234',
      department: 'finance', features: ['/employees'],
    });
    const res = await request(app)
      .get(`/api/v2/payroll/employee-overview/${new mongoose.Types.ObjectId()}`)
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).not.toBe(403);
  });

  test('Elastic Groups can load its production breakdown', async () => {
    const c = await createUser({
      name: 'GroupsOnly', email: 'groupsonly@t.co', password: 'pass1234',
      department: 'admin', features: ['/elastic-groups'],
    });
    const res = await request(app)
      .get('/api/v2/production/breakdown')
      .query({ start: '2026-01-01', end: '2026-01-31', groupBy: 'group', shift: 'all' })
      .set('Cookie', cookie(c.body.user.id, 'admin'));
    expect(res.status).not.toBe(403);
  });

  test('Machine Issues can log service against the machine it resolves', async () => {
    const c = await createUser({
      name: 'IssuesOnly', email: 'issuesonly@t.co', password: 'pass1234',
      department: 'production', features: ['/machine-issues'],
    });
    const res = await request(app)
      .post(`/api/v2/machine/${new mongoose.Types.ObjectId()}/add-service-log`)
      .set('Cookie', cookie(c.body.user.id, 'production'))
      .send({ note: 'resolved' });
    expect(res.status).not.toBe(403);
  });
});

describe('worker self-service reads stay open regardless of the feature list', () => {
  let worker, empDoc;

  beforeAll(async () => {
    empDoc = await Employee.create({ name: 'Self Worker', department: 'production', hourlyRate: 50 });
    const created = await createUser({
      name: 'SelfWorker', email: 'selfworker@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // no payroll/leave/bonus/attendance
    });
    worker = await User.findByIdAndUpdate(created.body.user.id, { employee: empDoc._id }, { new: true });
  });

  test('own payslip read (payroll) is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/payroll/slip/${empDoc._id}`)
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own leave history read is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/leave/employee/${empDoc._id}`)
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own bonus record read is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/bonus/employee/${empDoc._id}`)
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own attendance history read is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/attendance/employee/${empDoc._id}`)
      .query({ startDate: '2024-01-01', endDate: '2024-01-31' })
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('but an admin-only read on the same router is still feature-gated for that worker', async () => {
    // /date is the admin view on attendance — must stay blocked without
    // /attendance even though the worker's own read above is exempt.
    const res = await request(app)
      .get('/api/v2/attendance/date')
      .query({ date: '2024-01-01' })
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).toBe(403);
  });
});

// The employee mobile app is the only caller of these three routes, and it
// always passes the logged-in worker's own employee id. A packing-department
// worker's default features carry none of /production, /shift-plans,
// /shift-verification or /wastage, so gating these reads would black out
// their shift history, production-entry and wastage screens.
describe('employee-app self-service reads survive a feature list without the module keys', () => {
  let packer, packerEmp, otherEmp;

  beforeAll(async () => {
    packerEmp = await Employee.create({ name: 'Packer One', department: 'packing', hourlyRate: 40 });
    otherEmp  = await Employee.create({ name: 'Someone Else', department: 'production', hourlyRate: 40 });
    const created = await createUser({
      name: 'PackerOne', email: 'packerone@t.co', password: 'pass1234',
      department: 'packing', // defaults: no /production, /shift-plans, /shift-verification, /wastage
    });
    packer = await User.findByIdAndUpdate(created.body.user.id, { employee: packerEmp._id }, { new: true });
    // Guard the premise: if packing ever gains these keys the carve-out
    // below stops proving anything, and this assertion says so loudly.
    for (const k of ['/production', '/shift-plans', '/shift-verification', '/wastage']) {
      expect(packer.features).not.toContain(k);
    }
  });

  test('own open shifts are readable', async () => {
    const res = await request(app)
      .get('/api/v2/shift/employee-open-shifts')
      .query({ id: String(packerEmp._id) })
      .set('Cookie', cookie(packer._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own closed shifts are readable', async () => {
    const res = await request(app)
      .get('/api/v2/shift/employee-closed-shifts')
      .query({ id: String(packerEmp._id) })
      .set('Cookie', cookie(packer._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own wastage is readable', async () => {
    const res = await request(app)
      .get('/api/v2/wastage/get-by-employee')
      .query({ id: String(packerEmp._id) })
      .set('Cookie', cookie(packer._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  // The exemption is scoped by identity, so it can't be used as a way
  // around the gate by passing someone else's id.
  test('ANOTHER employee\'s shifts are not readable through the exempt route', async () => {
    const res = await request(app)
      .get('/api/v2/shift/employee-open-shifts')
      .query({ id: String(otherEmp._id) })
      .set('Cookie', cookie(packer._id, 'production'));
    expect(res.status).toBe(403);
  });

  test('ANOTHER employee\'s wastage is not readable through the exempt route', async () => {
    const res = await request(app)
      .get('/api/v2/wastage/get-by-employee')
      .query({ id: String(otherEmp._id) })
      .set('Cookie', cookie(packer._id, 'production'));
    expect(res.status).toBe(403);
  });

  test('the admin-facing shift reads on the same router ARE still gated', async () => {
    const res = await request(app)
      .get('/api/v2/shift/today')
      .set('Cookie', cookie(packer._id, 'production'));
    expect(res.status).toBe(403);
  });
});

// Elastic reads are consumed by exactly three screens — Elastics itself,
// the Order form and the Elastic Group form (the latter two pull the
// elastic list to pick from) — so all three keys grant the read and
// nothing else does.
// Structural guard. Four admin modules (/data-io, /users,
// /notification-settings, /advisor) shipped with a role gate and no
// feature gate, and nothing caught it because no test named them. This
// asserts the catalog itself: every revocable feature must be referenced
// by a real gate somewhere, so adding a feature without wiring its
// router fails here rather than in production.
describe('every revocable feature is actually enforced somewhere', () => {
  test('no non-always-on feature key is missing a gate', () => {
    const fs = require('fs');
    const path = require('path');
    const { FEATURES, ALWAYS_ON } = require('../../utils/features');

    const root = path.join(__dirname, '..', '..');
    const sources = [
      path.join(root, 'app.js'),
      ...fs.readdirSync(path.join(root, 'api'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(root, 'api', f)),
    ];

    const gated = new Set();
    for (const file of sources) {
      const src = fs.readFileSync(file, 'utf8');
      // Collect the keys inside every requireFeature/requireFeatureRead
      // call, including the multi-line ones in app.js.
      // requireFeature, requireFeatureRead and requireFeatureReadPaths —
      // the last takes its keys in an array plus a per-path widening map,
      // and both forms are just quoted keys inside the call.
      for (const m of src.matchAll(/requireFeature\w*\s*\(([^)]*)\)/g)) {
        const args = m[1];
        for (const key of args.matchAll(/['"](\/[^'"]*)['"]/g)) gated.add(key[1]);

        // Some routers spread a named constant — requireFeature(...KEYS).
        // Resolve it from its declaration in the same file rather than
        // loosening the scan to every quoted path in the file, which
        // would let a mere mention in a comment pass as enforcement.
        const spread = args.match(/\.\.\.\s*([A-Za-z_$][\w$]*)/);
        if (spread) {
          const decl = src.match(
            new RegExp(`${spread[1]}\\s*=\\s*\\[([^\\]]*)\\]`)
          );
          if (decl) {
            for (const key of decl[1].matchAll(/['"](\/[^'"]*)['"]/g)) gated.add(key[1]);
          }
        }
      }
    }

    const revocable = FEATURES.map((f) => f.key).filter((k) => !ALWAYS_ON.includes(k));
    const ungated = revocable.filter((k) => !gated.has(k));

    expect({ ungated }).toEqual({ ungated: [] });
  });
});

describe('elastic reads are feature-gated across their three consuming screens', () => {
  test('blocked without /elastics, /orders or /elastic-groups', async () => {
    const c = await createUser({
      name: 'ProdNoElastics', email: 'prodnoelastics@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],
    });
    const res = await request(app)
      .get('/api/v2/elastic/get-elastics')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  test('the per-elastic stock, orders and jobs roll-ups are gated too', async () => {
    const c = await createUser({
      name: 'ProdNoElastics2', email: 'prodnoelastics2@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],
    });
    const id = new mongoose.Types.ObjectId().toString();
    for (const path of [`/api/v2/elastic/${id}/stock`, `/api/v2/elastic/${id}/orders`, `/api/v2/elastic/${id}/jobs`]) {
      const res = await request(app).get(path).set('Cookie', cookie(c.body.user.id, 'production'));
      expect(res.status).toBe(403);
    }
  });

  test('allowed with /elastics', async () => {
    const c = await createUser({
      name: 'HasElastics', email: 'haselastics@t.co', password: 'pass1234',
      department: 'finance', features: ['/elastics'],
    });
    const res = await request(app)
      .get('/api/v2/elastic/get-elastics')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).not.toBe(403);
  });

  // The Order form picks elastics off this endpoint, so /orders alone
  // has to grant the read or order entry breaks.
  test('allowed with /orders alone (the Order form picks from this list)', async () => {
    const c = await createUser({
      name: 'OrdersOnly', email: 'ordersonly@t.co', password: 'pass1234',
      department: 'finance', features: ['/orders'],
    });
    const res = await request(app)
      .get('/api/v2/elastic/get-elastics')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).not.toBe(403);
  });

  test('writing still needs /elastics — a broader read key does not grant it', async () => {
    const c = await createUser({
      name: 'OrdersNoWrite', email: 'ordersnowrite@t.co', password: 'pass1234',
      department: 'finance', features: ['/orders'],
    });
    const res = await request(app)
      .post('/api/v2/elastic/create-elastic')
      .set('Cookie', cookie(c.body.user.id, 'accounts'))
      .send({});
    expect(res.status).toBe(403);
  });
});

// The admin-only modules were role-gated but never feature-gated, so an
// admin-DEPARTMENT account whose list had been narrowed on the Users page
// still reached them: the nav item was hidden and the API answered anyway.
// /io/export is the worst of these — it dumps the whole database.
describe('admin-only modules are feature-gated, not just role-gated', () => {
  let narrowedAdmin;

  beforeAll(async () => {
    const created = await createUser({
      name: 'NarrowAdmin', email: 'narrowadmin@t.co', password: 'pass1234',
      department: 'admin',
      features: ['/orders'], // admin ROLE, but none of the admin modules below
    });
    narrowedAdmin = created.body.user.id;
  });

  const denied = [
    ['full database export', '/api/v2/io/export'],
    ['import template',      '/api/v2/io/template'],
    ['notification settings','/api/v2/notify/settings'],
    ['notification log',     '/api/v2/notify/log'],
    ['the user roster',      '/api/v2/user/manage/list'],
  ];

  test.each(denied)('cannot read %s', async (_label, path) => {
    const res = await request(app).get(path).set('Cookie', cookie(narrowedAdmin, 'admin'));
    expect(res.status).toBe(403);
  });

  test('granting the feature restores access', async () => {
    const ok = await createUser({
      name: 'WideAdmin', email: 'wideadmin@t.co', password: 'pass1234',
      department: 'admin', features: ['/data-io', '/users', '/notification-settings'],
    });
    for (const path of ['/api/v2/io/export', '/api/v2/user/manage/list', '/api/v2/notify/settings']) {
      const res = await request(app).get(path).set('Cookie', cookie(ok.body.user.id, 'admin'));
      expect(res.status).not.toBe(403);
    }
  });

  test('the public login routes on the user router are NOT caught by the /manage gate', async () => {
    // The /users gate is scoped to the /manage prefix because this router
    // also serves unauthenticated login/OTP endpoints — a 401/400 here is
    // fine, a 403 would mean the gate leaked onto public routes.
    const res = await request(app).post('/api/v2/user/login-user').send({});
    expect(res.status).not.toBe(403);
  });
});

// Always-on features (depts:"all") must never be feature-gated: the web
// nav shows them to every user regardless of their list (navigation.ts
// canAccess), so a server-side gate would render a nav item that everyone
// can see and a narrowed user cannot open.
describe('always-on modules stay reachable for a narrowed feature list', () => {
  // GET / is isAdmin('admin','production','accounts'), so a production
  // user clears the role gate — a 403 here could only come from a
  // feature gate, which is exactly what must not exist on an always-on
  // module.
  test('machine-issues is readable by a user whose list omits it', async () => {
    const c = await createUser({
      name: 'NarrowList', email: 'narrowlist@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // no /machine-issues
    });
    const res = await request(app)
      .get('/api/v2/machine-issue')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });
});
