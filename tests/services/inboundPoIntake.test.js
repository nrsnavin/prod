'use strict';
// ══════════════════════════════════════════════════════════════════
//  DRAFTING AN ORDER FROM SOMEBODY ELSE'S DOCUMENT
//
//  The shift-sheet OCR reads OUR form: known layout, known columns,
//  known codes. This reads a customer's — a photo of a letterhead, a
//  forwarded PDF, a picture of a page on a desk. Nothing is keyed, so
//  every field is a guess that a person has to check.
//
//  The extraction is stubbed here. That is not a shortcut: what needs
//  testing is what the service DOES with what it read — the matching,
//  the confidence, and above all the things it refuses to do. A live
//  model would make every assertion non-deterministic while proving
//  nothing about the code under test.
//
//  Three properties, in order of what they cost when broken:
//
//    • it creates NOTHING — no order, no customer, no elastic
//    • a 20mm line never preselects a 25mm product
//    • an unsure line comes back unsure, with the alternatives
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../utils/inboundPoOcr', () => ({
  extractPurchaseOrder: jest.fn(),
  IMAGE_TYPES: new Set(['image/jpeg', 'image/png']),
  PDF_TYPE: 'application/pdf',
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { extractPurchaseOrder } = require('../../utils/inboundPoOcr');

let mongo, intake, Customer, Elastic, Order, AiSuggestion;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  intake       = require('../../services/inboundPoIntake');
  Customer     = require('../../models/Customer');
  Elastic      = require('../../models/Elastic');
  Order        = require('../../models/Order');
  AiSuggestion = require('../../models/AiSuggestion');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  extractPurchaseOrder.mockReset();
  await Customer.create({ name: 'Sri Lakshmi Garments', contactName: 'R', phoneNumber: `900000${seq++}` });
  await Customer.create({ name: 'Anand Hosiery',        contactName: 'K', phoneNumber: `900001${seq++}` });
  await makeElastic('20mm Knitted Elastic - White');
  await makeElastic('25mm Knitted Elastic - White');
  await makeElastic('38mm Woven Elastic - Natural');
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const makeElastic = (name, over = {}) => Elastic.create({
  name, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
  pick: 12, noOfHook: 8, weight: 2.4, ...over,
});

/** What the (stubbed) vision call returns. */
const reading = (over = {}) => ({
  available: true, ok: true, model: 'vision-x',
  usage: { input_tokens: 1200, output_tokens: 300 },
  draft: {
    customerName: 'Sri Lakshmi Garments',
    poNumber: 'PO-8891', poDate: '2026-08-01', deliveryDate: '2026-09-15',
    currency: 'INR', notes: '', confidence: 0.9,
    lines: [
      { description: '20mm Knitted Elastic - White', quantity: 5000, unit: 'm', rate: 12.5, confidence: 0.92 },
    ],
    ...over,
  },
});

const draft = () => intake.draftFromDocument(Buffer.from('x'), 'image/png', {});

// ══════════════════════════════════════════════════════════════════
//  1. IT CREATES NOTHING
// ══════════════════════════════════════════════════════════════════
describe('stage, verify, apply', () => {
  test('no order, customer or elastic is created', async () => {
    // The pattern the shift sheet and QC vision use, and the reason
    // both are trusted on the floor. A document that drafts itself
    // straight into an order is a document nobody checks.
    extractPurchaseOrder.mockResolvedValue(reading());

    const before = await Order.countDocuments({});
    const out = await draft();

    expect(out.ok).toBe(true);
    expect(await Order.countDocuments({})).toBe(before);
    expect(await Customer.countDocuments({})).toBe(2);
    expect(await Elastic.countDocuments({})).toBe(3);
  });

  test('the response says out loud that nothing was created', async () => {
    // Anything reading this API has to know it is holding a proposal,
    // not a result. Saying it only in the UI leaves the next client to
    // find out the hard way.
    extractPurchaseOrder.mockResolvedValue(reading());
    const out = await draft();
    expect(out.disclaimer).toMatch(/nothing has been created/i);
    expect(out.disclaimer).toMatch(/check every line/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE MATCH
// ══════════════════════════════════════════════════════════════════
describe('matching against the masters', () => {
  test('a clean document matches the customer and every line', async () => {
    extractPurchaseOrder.mockResolvedValue(reading());
    const out = await draft();

    expect(out.draft.customer).toMatchObject({
      customerName: 'Sri Lakshmi Garments', confident: true,
    });
    expect(out.draft.lines[0].match).toMatchObject({
      elasticName: '20mm Knitted Elastic - White', confident: true,
    });
    expect(out.summary).toMatchObject({ lines: 1, matched: 1, needsAttention: 0, customerMatched: true });
  });

  test('a 20mm line never preselects the 25mm product', async () => {
    // The failure this whole feature turns on. The two names are one
    // character apart; shipping the wrong one means the lot comes back.
    extractPurchaseOrder.mockResolvedValue(reading({
      lines: [{ description: '20MM KNITTED ELASTIC WHT', quantity: 3000, unit: 'm', rate: 12, confidence: 0.7 }],
    }));

    const out = await draft();
    const m = out.draft.lines[0].match;

    expect(m.candidates.map((c) => c.name)).not.toContain('25mm Knitted Elastic - White');
    // And it says WHY, so nobody assumes the master is missing it and
    // creates a duplicate product.
    expect(m.blockedByWidth.map((b) => b.name)).toContain('25mm Knitted Elastic - White');
    expect(m.blockedByWidth[0].reason).toMatch(/says 20/);
  });

  test('an ambiguous line comes back unsure, with its alternatives', async () => {
    await makeElastic('20mm Knitted Elastic - Black');
    extractPurchaseOrder.mockResolvedValue(reading({
      lines: [{ description: '20mm Knitted Elastic', quantity: 1000, unit: 'm', rate: 11, confidence: 0.6 }],
    }));

    const out = await draft();
    const m = out.draft.lines[0].match;

    expect(m.confident).toBe(false);
    expect(m.elasticId).toBeNull();
    // The wrong pick has to be one click to fix, which only works if
    // the alternatives came back.
    expect(m.candidates.length).toBeGreaterThanOrEqual(2);
    expect(out.summary.needsAttention).toBe(1);
  });

  test('a product we do not make matches nothing rather than the nearest thing', async () => {
    extractPurchaseOrder.mockResolvedValue(reading({
      lines: [{ description: 'Nylon zip fastener 6 inch', quantity: 100, unit: 'pcs', rate: 8, confidence: 0.8 }],
    }));

    const out = await draft();
    expect(out.draft.lines[0].match.candidates).toEqual([]);
    expect(out.draft.lines[0].match.confident).toBe(false);
  });

  test('an archived product is not offered', async () => {
    // Drafting an order for something the plant has stopped making
    // wastes everybody's time downstream.
    await makeElastic('45mm Knitted Elastic - White', { archived: true });
    extractPurchaseOrder.mockResolvedValue(reading({
      lines: [{ description: '45mm Knitted Elastic - White', quantity: 100, unit: 'm', rate: 9, confidence: 0.9 }],
    }));

    const out = await draft();
    expect(out.draft.lines[0].match.candidates).toEqual([]);
  });

  test('an unknown customer is left for a person to pick', async () => {
    extractPurchaseOrder.mockResolvedValue(reading({ customerName: 'Some New Buyer Ltd' }));
    const out = await draft();
    expect(out.draft.customer.confident).toBe(false);
    expect(out.draft.customer.customerId).toBeNull();
    expect(out.summary.customerMatched).toBe(false);
  });

  test('a document with no customer name at all does not throw', async () => {
    extractPurchaseOrder.mockResolvedValue(reading({ customerName: null }));
    const out = await draft();
    expect(out.draft.customer.candidates).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. WHAT IS RECORDED
// ══════════════════════════════════════════════════════════════════
describe('the ledger', () => {
  test('a reading is recorded before anybody sees it', async () => {
    extractPurchaseOrder.mockResolvedValue(reading());
    const out = await draft();

    expect(out.aiSuggestionId).toBeTruthy();
    const row = await AiSuggestion.findById(out.aiSuggestionId).lean();
    expect(row.surface).toBe('inbound-po-ocr');
    expect(row.outcome).toBe('proposed');
    expect(row.inputTokens).toBe(1200);
  });

  test('what the person saved is settled against what was read', async () => {
    // Without this the accuracy of reading somebody else's paperwork
    // stays exactly as unknowable as it is today.
    extractPurchaseOrder.mockResolvedValue(reading());
    const out = await draft();

    await intake.settleDraft(out.aiSuggestionId, {
      order: {
        customerName: 'Sri Lakshmi Garments',
        po: 'PO-8891',
        lines: [{
          description: '20mm Knitted Elastic - White',
          quantity: 5000,
          rate: 13.0,                       // the price was renegotiated
          elasticName: '20mm Knitted Elastic - White',
        }],
      },
    });

    const row = await AiSuggestion.findById(out.aiSuggestionId).lean();
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(['lines[].rate']);
  });

  test('an unreadable document is recorded as a failure, not silence', async () => {
    // A model that had started replying in prose would otherwise look
    // exactly like a feature nobody uses.
    extractPurchaseOrder.mockResolvedValue({ available: true, ok: false, model: 'vision-x' });

    const out = await draft();
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/enter the order manually/i);

    const rows = await AiSuggestion.find({ surface: 'inbound-po-ocr' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
  });

  test('a thrown extraction error is recorded and re-thrown', async () => {
    extractPurchaseOrder.mockRejectedValue(new Error('upstream 529'));
    await expect(draft()).rejects.toThrow(/529/);

    const rows = await AiSuggestion.find({ surface: 'inbound-po-ocr' }).lean();
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].error).toMatch(/529/);
  });

  test('an unsupported file type is the caller\'s mistake, not the model\'s', async () => {
    // Counting it against the surface would make "somebody uploaded a
    // .docx" read as "the AI is failing".
    const err = new Error('Unsupported file type');
    err.code = 'UNSUPPORTED_TYPE';
    extractPurchaseOrder.mockRejectedValue(err);

    await expect(draft()).rejects.toThrow(/unsupported/i);
    expect(await AiSuggestion.countDocuments({})).toBe(0);
  });

  test('no API key is reported as unconfigured, not as a failure', async () => {
    extractPurchaseOrder.mockResolvedValue({ available: false });
    const out = await draft();
    expect(out.available).toBe(false);
    expect(await AiSuggestion.countDocuments({})).toBe(0);
  });

  test('settling with no id or no order is a no-op', async () => {
    expect(await intake.settleDraft(null, { order: {} })).toBeNull();
    expect(await intake.settleDraft('abc', null)).toBeNull();
  });
});
