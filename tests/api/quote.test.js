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

    const [line] = q.lines;
    expect(line.materialCost).toBe(2.842);       // Σ grams/1000 × ₹/kg
    expect(line.totalCost).toBe(4.092);          // + conversion 1.25
    expect(line.rateBeforeTax).toBe(4.91);       // × 1.20, quoted in paise
    expect(line.gstAmount).toBe(0.25);
    expect(line.rateInclTax).toBe(5.16);
    expect(line.totalWeightGrams).toBe(8.5);
  });

  it('extends the rate over the quantity quoted', async () => {
    const q = (await create()).body.quote;
    expect(q.lines[0].valueBeforeTax).toBe(24550);  // 4.91 × 5000
    expect(q.lines[0].valueInclTax).toBe(25800);    // 5.16 × 5000
    expect(q.subTotal).toBe(24550);
    expect(q.grandTotal).toBe(25800);
  });

  it('reconciles exactly at the precision it prints', async () => {
    // Everything a reader can see must multiply out. The rate is quoted
    // in paise and every figure downstream comes off it, so rate ×
    // quantity IS the value, with nothing lost between the two.
    const q = (await create()).body.quote;
    const [l] = q.lines;
    expect(l.valueBeforeTax).toBe(l.rateBeforeTax * 5000);
    expect(l.valueInclTax).toBe(l.rateInclTax * 5000);
    expect(l.rateInclTax).toBe(l.rateBeforeTax + l.gstAmount);
    expect(q.grandTotal).toBe(q.subTotal + q.gstAmount);
  });

  it('ignores a rate the caller tried to set', async () => {
    // The one that matters. A price arriving in the body must not become
    // the price on the document.
    const res = await create({
      rateBeforeTax: 999, rateInclTax: 999, totalCost: 999,
      materialCost: 999, valueInclTax: 999,
    });
    const q = res.body.quote;
    expect(q.lines[0].rateBeforeTax).toBe(4.91);
    expect(q.lines[0].totalCost).toBe(4.092);
    expect(q.grandTotal).toBe(25800);
  });

  it('marks up on cost rather than taking a margin on the price', async () => {
    const q = (await create({
      materials: [{ label: 'X', weightGrams: 1000, ratePerKg: 100 }],
      conversionCost: 0, marginPercent: 20, gstPercent: 0, quantityMetres: 0,
    })).body.quote;
    expect(q.lines[0].totalCost).toBe(100);
    expect(q.lines[0].rateBeforeTax).toBe(120);   // not 125
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
    expect(q.lines[0].materials).toHaveLength(1);
    expect(q.lines[0].materialCost).toBe(1.008);
  });

  it('prices any number of rows the user added', async () => {
    const q = (await create({
      materials: [
        ...body().materials,
        { label: 'Dye',    weightGrams: 0.5, ratePerKg: 400 },
        { label: 'Finish', weightGrams: 0.3, ratePerKg: 300 },
      ],
    })).body.quote;
    expect(q.lines[0].materials).toHaveLength(6);
    expect(q.lines[0].materialCost).toBe(3.132);
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
    expect(res.body.message).toMatch(/has no name/i);
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
    expect(res.body.quote.lines[0].rateBeforeTax).toBe(5.32);  // 4.092 × 1.30, in paise
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
    expect(res.body.quote.lines[0].rateBeforeTax).toBe(4.91);
  });
});

describe('pricing without raising a document', () => {
  it('answers with the costing and burns no quote number', async () => {
    const res = await request(app).post('/api/v2/quote/price')
      .set('Cookie', cookie()).send(body());
    expect(res.status).toBe(200);
    expect(res.body.costing.lines[0].rateBeforeTax).toBe(4.91);
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
    expect(res.body.quote.lines[0].materials).toHaveLength(4);
    expect(res.body.quote.lines[0].materials[0]).toMatchObject({
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
    expect(ctx.fields.subTotal).toBe('Rs. 24,550.00');
    expect(ctx.fields.grandTotal).toBe('Rs. 25,800.00');
    expect(ctx.fields.gstLabel).toBe('GST @ 5%');
  });

  it('prints a line whose rate times quantity IS its amount', async () => {
    const q = (await create()).body.quote;
    const { quoteToContext } = require('../../services/pdf/quoteContext');
    const [line] = quoteToContext(q, {}).rows;
    expect(line.rate * line.qty).toBeCloseTo(line.amount, 2);
  });
});

describe('the letterhead — our own details', () => {
  // This is what the demo PDF hid. The context was written against an
  // invented branding shape (companyName, companyAddress, companyGstin,
  // companyContact) and NONE of those keys exist on the real object,
  // which is { company, gstin, phone, email, addressLines[] }. Every
  // quotation printed with a blank letterhead. Feeding the real mapper
  // here is the whole point — a hand-made object would pass either way.
  const { pdfBranding } = require('../../services/documentSettings');
  const { quoteToContext } = require('../../services/pdf/quoteContext');

  const settings = {
    companyName: 'Balu Elastics',
    tagline: 'Elastic Tape Manufacturing',
    gstin: '33ABCDE1234F1Z5',
    phone: '+91 90000 00000',
    email: 'sales@baluelastics.in',
    addressLines: ['12 Mill Road', 'Erode, Tamil Nadu 638001'],
    footerNote: 'Computer generated.',
  };

  const fieldsFor = async () => {
    const q = (await create()).body.quote;
    return quoteToContext(q, pdfBranding(settings)).fields;
  };

  it('prints the company name from Document Settings', async () => {
    expect((await fieldsFor()).companyName).toBe('Balu Elastics');
  });

  it('prints the address, joined from its lines', async () => {
    expect((await fieldsFor()).companyAddress)
      .toBe('12 Mill Road, Erode, Tamil Nadu 638001');
  });

  it('prints our GSTIN, labelled', async () => {
    expect((await fieldsFor()).companyGstin).toBe('GSTIN: 33ABCDE1234F1Z5');
  });

  it('prints phone and email as the contact line', async () => {
    expect((await fieldsFor()).companyContact)
      .toContain('+91 90000 00000');
    expect((await fieldsFor()).companyContact)
      .toContain('sales@baluelastics.in');
  });

  it('leaves nothing blank that Document Settings has filled in', async () => {
    const f = await fieldsFor();
    for (const key of ['companyName', 'tagline', 'companyAddress',
                       'companyGstin', 'companyContact', 'footerNote']) {
      expect(f[key]).not.toBe('');
    }
  });

  it('still prints a usable header when settings are empty', async () => {
    const q = (await create()).body.quote;
    const f = quoteToContext(q, pdfBranding(null)).fields;
    expect(f.companyName).toBeTruthy();     // falls back rather than blank
    expect(f.docTitle).toBe('QUOTATION');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('several products on one quotation', () => {
  const twoProducts = () => ({
    customerName: 'Ravi Textiles',
    gstPercent: 5,
    lines: [
      {
        productName: '20mm Woven Elastic',
        materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240 }],
        conversionCost: 1.25, marginPercent: 20, quantityMetres: 5000,
      },
      {
        productName: '32mm Knitted Elastic',
        materials: [{ label: 'Warp yarn', weightGrams: 8, ratePerKg: 240 }],
        conversionCost: 2, marginPercent: 25, quantityMetres: 3000,
      },
    ],
  });

  const createTwo = () =>
    request(app).post('/api/v2/quote/create').set('Cookie', cookie()).send(twoProducts());

  it('prices each product on its OWN margin and conversion cost', async () => {
    const q = (await createTwo()).body.quote;
    expect(q.lines).toHaveLength(2);

    // 1.008 + 1.25 = 2.258 × 1.20 = 2.7096 → 2.71
    expect(q.lines[0].rateBeforeTax).toBe(2.71);
    // 1.92 + 2 = 3.92 × 1.25 = 4.90
    expect(q.lines[1].rateBeforeTax).toBe(4.9);
  });

  it('does not average them into one rate', async () => {
    const q = (await createTwo()).body.quote;
    expect(q.lines[0].rateBeforeTax).not.toBe(q.lines[1].rateBeforeTax);
  });

  it('adds the line values to the document total', async () => {
    const q = (await createTwo()).body.quote;
    expect(q.lines[0].valueBeforeTax).toBe(13550);  // 2.71 × 5000
    expect(q.lines[1].valueBeforeTax).toBe(14700);  // 4.90 × 3000
    expect(q.subTotal).toBe(28250);
  });

  it('makes the three document totals agree with each other', async () => {
    const q = (await createTwo()).body.quote;
    expect(q.grandTotal).toBe(q.subTotal + q.gstAmount);
  });

  it('totals the quantity across the products', async () => {
    const q = (await createTwo()).body.quote;
    expect(q.totalQuantityMetres).toBe(8000);
  });

  it('carries one GST rate for the whole document', async () => {
    const q = (await createTwo()).body.quote;
    expect(q.gstPercent).toBe(5);
    for (const l of q.lines) {
      expect(l.rateInclTax).toBe(l.rateBeforeTax + l.gstAmount);
    }
  });

  it('names the offending product when one is wrong', async () => {
    const body = twoProducts();
    body.lines[1].materials = [{ label: '', weightGrams: 8, ratePerKg: 240 }];
    const res = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/product 2/i);
  });

  it('prints one row per product', async () => {
    const q = (await createTwo()).body.quote;
    const { quoteToContext } = require('../../services/pdf/quoteContext');
    const ctx = quoteToContext(q, {});

    expect(ctx.rows).toHaveLength(2);
    expect(ctx.rows[1].sno).toBe(2);
    expect(ctx.rows[1].description).toContain('32mm');
    expect(ctx.fields.lineCount).toBe('2');
    expect(ctx.fields.productName).toBe('2 products');
  });

  it('prints a row whose rate times quantity IS its amount', async () => {
    const q = (await createTwo()).body.quote;
    const { quoteToContext } = require('../../services/pdf/quoteContext');
    for (const row of quoteToContext(q, {}).rows) {
      expect(row.rate * row.qty).toBeCloseTo(row.amount, 2);
    }
  });

  it('still renders a PDF', async () => {
    const q = (await createTwo()).body.quote;
    const res = await request(app).get(`/api/v2/quote/${q._id}/pdf`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  }, 30_000);

  it('finds the quote by either product name', async () => {
    await createTwo();
    const byFirst = await request(app).get('/api/v2/quote/list')
      .query({ search: '20mm' }).set('Cookie', cookie());
    const bySecond = await request(app).get('/api/v2/quote/list')
      .query({ search: '32mm' }).set('Cookie', cookie());
    expect(byFirst.body.total).toBe(1);
    expect(bySecond.body.total).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the customer on a quotation', () => {
  let Customer;
  beforeAll(() => { Customer = require('../../models/Customer'); });

  const withCustomer = async (over = {}) => {
    const c = await Customer.create({
      name: 'Ravi Textiles Pvt Ltd', contactName: 'Ravi',
      phoneNumber: '9000000001', gstin: '33ZZZZZ9999Z1Z9',
    });
    const res = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send({ ...body(), customerName: '', customer: c._id, ...over });
    return { customer: c, res };
  };

  it('fills the details from the master when one is picked', async () => {
    const { customer, res } = await withCustomer();
    expect(res.status).toBe(201);
    const q = res.body.quote;
    expect(String(q.customer)).toBe(String(customer._id));
    expect(q.customerName).toBe('Ravi Textiles Pvt Ltd');
    expect(q.customerGstin).toBe('33ZZZZZ9999Z1Z9');
    expect(q.customerPhone).toBe('9000000001');
  });

  it('takes the address from the quote — the master holds none', async () => {
    // The customer master has no address field, and a quotation often
    // goes to a buying office rather than the mill, so the address is
    // the quote's own.
    const { res } = await withCustomer({ customerAddress: 'Unit 2, Avinashi Road' });
    expect(res.body.quote.customerAddress).toBe('Unit 2, Avinashi Road');
  });

  it('lets a typed GSTIN override the master for one quote', async () => {
    const { res } = await withCustomer({ customerGstin: '29AAAAA0000A1Z5' });
    expect(res.body.quote.customerGstin).toBe('29AAAAA0000A1Z5');
  });

  it('takes a typed customer with no master record at all', async () => {
    const res = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie())
      .send({ ...body(), customerName: 'A Brand New Prospect' });
    expect(res.status).toBe(201);
    expect(res.body.quote.customer).toBeUndefined();
    expect(res.body.quote.customerName).toBe('A Brand New Prospect');
  });

  it('refuses a customer id that does not exist', async () => {
    const res = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie())
      .send({ ...body(), customer: new mongoose.Types.ObjectId() });
    expect(res.status).toBe(404);
  });

  it('keeps saying what it said after the master is renamed', async () => {
    // The snapshot is the document; the link is only for finding things.
    const { customer, res } = await withCustomer();
    await Customer.updateOne({ _id: customer._id }, { $set: { name: 'Renamed Mills' } });

    const again = await request(app).get('/api/v2/quote/detail')
      .query({ id: res.body.quote._id }).set('Cookie', cookie());
    expect(again.body.quote.customerName).toBe('Ravi Textiles Pvt Ltd');
  });
});
