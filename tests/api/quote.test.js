'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAISING A QUOTATION
//
//  A quote is a price a customer is entitled to hold you to, which
//  shapes everything here:
//
//    • the SERVER prices it. The form does the same arithmetic live as
//      you type, but a total arriving in the request body is ignored —
//      otherwise a stale tab or a hand-edited request sets the price
//      this business is bound by.
//
//    • the costing is FROZEN on the document. Reopened next month it
//      must still explain the price it went out at, not restate itself
//      at today's yarn costs.
//
//    • numbers come from an atomic counter, per financial year, so two
//      people quoting at once cannot both be QT-25/26-0001.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Quote, User, admin;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app   = require('../../app.js');
  Quote = require('../../models/Quote');
  User  = require('../../models/User');
  admin = await User.create({
    name: 'Sales', email: 'q@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// A real 20mm woven elastic: 8.5 g of yarn in a metre.
const body = (over = {}) => ({
  customerName: 'Ravi Textiles',
  productName:  '20mm Woven Elastic',
  productSpec:  'Width 20mm · Elongation 120%',
  materials: [
    { label: 'Warp yarn',        weightGrams: 4.2, ratePerKg: 240 },
    { label: 'Spandex covering', weightGrams: 1.1, ratePerKg: 620 },
    { label: 'Warp spandex',     weightGrams: 0.8, ratePerKg: 900 },
    { label: 'Weft yarn',        weightGrams: 2.4, ratePerKg: 180 },
  ],
  conversionCost: 1.25,
  marginPercent: 20,
  gstPercent: 5,
  quantityMetres: 5000,
  ...over,
});

const create = (over) =>
  request(app).post('/api/v2/quote/create').set('Cookie', cookie()).send(body(over));

// ══════════════════════════════════════════════════════════════════
describe('the price the server puts on a quote', () => {
  it('works the whole chain out for itself', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    const q = res.body.quote;

    expect(q.materialCost).toBe(2.842);       // Σ grams/1000 × ₹/kg
    expect(q.totalCost).toBe(4.092);          // + conversion 1.25
    expect(q.rateBeforeTax).toBe(4.91);       // × 1.20, quoted in paise
    expect(q.gstAmount).toBe(0.25);
    expect(q.rateInclTax).toBe(5.16);
    expect(q.totalWeightGrams).toBe(8.5);
  });

  it('extends the rate over the quantity quoted', async () => {
    const q = (await create()).body.quote;
    expect(q.valueBeforeTax).toBe(24550);     // 4.91 × 5000
    expect(q.valueInclTax).toBe(25800);       // 5.16 × 5000
  });

  it('reconciles exactly at the precision it prints', async () => {
    // Everything a reader can see must multiply out. The rate is quoted
    // in paise and every figure downstream comes off it, so rate ×
    // quantity IS the value, with nothing lost between the two.
    const q = (await create()).body.quote;
    expect(q.valueBeforeTax).toBe(q.rateBeforeTax * 5000);
    expect(q.valueInclTax).toBe(q.rateInclTax * 5000);
    expect(q.rateInclTax).toBe(q.rateBeforeTax + q.gstAmount);
  });

  it('ignores a rate the caller tried to set', async () => {
    // The one that matters. A price arriving in the body must not become
    // the price on the document.
    const res = await create({
      rateBeforeTax: 999, rateInclTax: 999, totalCost: 999,
      materialCost: 999, valueInclTax: 999,
    });
    const q = res.body.quote;
    expect(q.rateBeforeTax).toBe(4.91);
    expect(q.totalCost).toBe(4.092);
    expect(q.valueInclTax).toBe(25800);
  });

  it('marks up on cost rather than taking a margin on the price', async () => {
    const q = (await create({
      materials: [{ label: 'X', weightGrams: 1000, ratePerKg: 100 }],
      conversionCost: 0, marginPercent: 20, gstPercent: 0, quantityMetres: 0,
    })).body.quote;
    expect(q.totalCost).toBe(100);
    expect(q.rateBeforeTax).toBe(120);   // not 125
  });

  it('defaults GST to 5% when it is not given', async () => {
    const b = body(); delete b.gstPercent;
    const res = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(b);
    expect(res.body.quote.gstPercent).toBe(5);
  });
});

describe('the four rows, and the ones added after them', () => {
  it('drops a row left completely blank rather than refusing the quote', async () => {
    const q = (await create({
      materials: [
        { label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240 },
        { label: 'Weft yarn', weightGrams: 0,   ratePerKg: 0 },
      ],
    })).body.quote;
    expect(q.materials).toHaveLength(1);
    expect(q.materialCost).toBe(1.008);
  });

  it('prices any number of rows the user added', async () => {
    const q = (await create({
      materials: [
        ...body().materials,
        { label: 'Dye',    weightGrams: 0.5, ratePerKg: 400 },
        { label: 'Finish', weightGrams: 0.3, ratePerKg: 300 },
      ],
    })).body.quote;
    expect(q.materials).toHaveLength(6);
    expect(q.materialCost).toBe(3.132);
  });

  it('refuses a row that has figures but no name', async () => {
    const res = await create({
      materials: [{ label: '', weightGrams: 4.2, ratePerKg: 240 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no material name/i);
  });

  it('refuses a negative weight rather than discounting the quote', async () => {
    const res = await create({
      materials: [{ label: 'Warp yarn', weightGrams: -4.2, ratePerKg: 240 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/negative/i);
  });

  it('refuses a quote with nothing priced at all', async () => {
    const res = await create({ materials: [{ label: 'Warp yarn', weightGrams: 0, ratePerKg: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one material/i);
  });
});

describe('the quote number', () => {
  it('is numbered within the financial year', async () => {
    const q = (await create()).body.quote;
    expect(q.quoteNo).toMatch(/^QT-\d{2}\/\d{2}-0001$/);
    expect(q.sequence).toBe(1);
  });

  it('runs on for the next quote', async () => {
    await create();
    const second = (await create()).body.quote;
    expect(second.sequence).toBe(2);
    expect(second.quoteNo).toMatch(/-0002$/);
  });

  it('gives concurrent quotes distinct numbers', async () => {
    const results = await Promise.all([create(), create(), create(), create()]);
    const numbers = results.map((r) => r.body.quote.quoteNo);
    expect(new Set(numbers).size).toBe(4);
  });

  it('puts an April date in the new financial year', async () => {
    const q = (await create({ date: '2026-04-01' })).body.quote;
    expect(q.financialYear).toBe('26/27');
  });

  it('puts a March date in the old one', async () => {
    const q = (await create({ date: '2026-03-31' })).body.quote;
    expect(q.financialYear).toBe('25/26');
  });
});

describe('how long the price holds', () => {
  it('defaults to thirty days from the quote date', async () => {
    const q = (await create({ date: '2026-08-12' })).body.quote;
    expect(new Date(q.validTill).toISOString().slice(0, 10)).toBe('2026-09-11');
  });

  it('takes the date given instead', async () => {
    const q = (await create({ date: '2026-08-12', validTill: '2026-08-20' })).body.quote;
    expect(new Date(q.validTill).toISOString().slice(0, 10)).toBe('2026-08-20');
  });

  it('refuses a price that expires before it is offered', async () => {
    const res = await create({ date: '2026-08-12', validTill: '2026-08-01' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/before it is offered|before the quote date/i);
  });
});

describe('what a quote will not do without', () => {
  it('needs a customer', async () => {
    const res = await create({ customerName: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/customer name/i);
  });

  it('needs a product', async () => {
    const res = await create({ productName: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/product name/i);
  });
});

describe('repricing a quote', () => {
  const edit = (id, over = {}) =>
    request(app).put('/api/v2/quote/update').set('Cookie', cookie())
      .send({ id, auditReason: 'Yarn price moved', ...over });

  it('recomputes from the new figures', async () => {
    const q = (await create()).body.quote;
    const res = await edit(q._id, { materials: body().materials, marginPercent: 30, conversionCost: 1.25, gstPercent: 5, quantityMetres: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.quote.rateBeforeTax).toBe(5.32);     // 4.092 × 1.30, in paise
  });

  it('needs a reason', async () => {
    const q = (await create()).body.quote;
    const res = await request(app).put('/api/v2/quote/update')
      .set('Cookie', cookie()).send({ id: q._id, marginPercent: 30 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reason/i);
  });

  it('refuses once the customer has accepted it', async () => {
    const q = (await create()).body.quote;
    await request(app).patch('/api/v2/quote/status')
      .set('Cookie', cookie()).send({ id: q._id, status: 'accepted' });

    const res = await edit(q._id, { marginPercent: 40 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/settled|fresh quote/i);
  });

  it('leaves the frozen costing alone when only the customer changes', async () => {
    const q = (await create()).body.quote;
    const res = await edit(q._id, { customerName: 'New Name Textiles' });
    expect(res.body.quote.customerName).toBe('New Name Textiles');
    expect(res.body.quote.rateBeforeTax).toBe(4.91);
  });
});

describe('pricing without raising a document', () => {
  it('answers with the costing and burns no quote number', async () => {
    const res = await request(app).post('/api/v2/quote/price')
      .set('Cookie', cookie()).send(body());
    expect(res.status).toBe(200);
    expect(res.body.costing.rateBeforeTax).toBe(4.91);
    expect(await Quote.countDocuments({})).toBe(0);
  });
});

describe('the printed quotation', () => {
  it('renders a PDF', async () => {
    const q = (await create()).body.quote;
    const res = await request(app).get(`/api/v2/quote/${q._id}/pdf`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  }, 30_000);

  it('names the file after the quote', async () => {
    const q = (await create()).body.quote;
    const res = await request(app).get(`/api/v2/quote/${q._id}/pdf`).set('Cookie', cookie());
    expect(res.headers['content-disposition']).toMatch(/QT-\d{2}_\d{2}-0001\.pdf/);
  }, 30_000);
});

describe('finding a quote again', () => {
  it('lists them newest first', async () => {
    await create({ customerName: 'A Textiles' });
    await create({ customerName: 'B Textiles' });
    const res = await request(app).get('/api/v2/quote/list').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('searches by quote number, customer and product', async () => {
    await create({ customerName: 'Findable Mills' });
    const byCustomer = await request(app).get('/api/v2/quote/list')
      .query({ search: 'Findable' }).set('Cookie', cookie());
    expect(byCustomer.body.total).toBe(1);

    const byProduct = await request(app).get('/api/v2/quote/list')
      .query({ search: '20mm' }).set('Cookie', cookie());
    expect(byProduct.body.total).toBe(1);
  });

  it('returns the frozen costing on the detail', async () => {
    const q = (await create()).body.quote;
    const res = await request(app).get('/api/v2/quote/detail')
      .query({ id: q._id }).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.quote.materials).toHaveLength(4);
    expect(res.body.quote.materials[0]).toMatchObject({
      label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240, cost: 1.008,
    });
  });
});

describe('the figures as the quotation prints them', () => {
  // The demo PDF caught this: the line table formatted the rate with the
  // purchase order's whole-rupee currency format, so a Rs 5.15 rate
  // printed as "Rs. 5". A buyer multiplying that by 25,000 m landed
  // Rs 3,750 away from the amount printed beside it.
  const { getDocType } = require('../../services/pdf/docTypes');

  it('gives the rate and amount columns a format that keeps paise', () => {
    const cols = getDocType('quotation').columns;
    const byField = Object.fromEntries(cols.map((c) => [c.field, c.format]));
    expect(byField.rate).toBe('currency2');
    expect(byField.amount).toBe('currency2');
  });

  it('renders a rate that reads in paise, not whole rupees', async () => {
    const q = (await create()).body.quote;
    const { quoteToContext } = require('../../services/pdf/quoteContext');
    const ctx = quoteToContext(q, {});
    expect(ctx.fields.rateExclTax).toBe('Rs. 4.91');
    expect(ctx.fields.rateInclTax).toBe('Rs. 5.16');
    expect(ctx.fields.gstLabel).toBe('GST @ 5%');
  });

  it('prints a line whose rate times quantity IS its amount', async () => {
    const q = (await create()).body.quote;
    const { quoteToContext } = require('../../services/pdf/quoteContext');
    const [line] = quoteToContext(q, {}).rows;
    expect(line.rate * line.qty).toBeCloseTo(line.amount, 2);
  });
});
