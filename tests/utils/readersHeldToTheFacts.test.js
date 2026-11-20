'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A PHOTO READER HANDS BACK
//
//  Found reading the photo and paper readers in utils/ line by line.
//  Each is a rule that most of the readers already kept and a few did
//  not:
//
//    • a day that does not exist is no date — four readers still asked
//      only for the SHAPE of one (the customer's PO, a goods receipt, an
//      ID card's date of birth, a proof of delivery)
//    • a notice's financial year is a year ("2026-28" is not one)
//    • "today", told to the model, is today in India
//    • the holder of a cancelled cheque is the supplier when the NAMES
//      agree — not when one is a few letters found inside the other
//      ("RAJ" inside "RAJESH TEXTILES")
//    • a quality photo passes only when the model said pass: "FAIL",
//      a failed line, or "false" written as text used to read as a pass
//    • a reply cut off because the paper was too long says so, instead
//      of "unreadable"
// ══════════════════════════════════════════════════════════════════

let mockReply = { content: [{ type: 'text', text: '{}' }], usage: {}, stop_reason: 'end_turn' };
const mockCreate = jest.fn(async () => mockReply);
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }), VISION_MODEL: 'test-vision', TEXT_MODEL: 'test-text', isPinned: () => true }));

const says = (obj, stop = 'end_turn') => { mockReply = { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], usage: {}, stop_reason: stop }; };
const photo = { buffer: Buffer.from('x'), mimetype: 'image/jpeg' };

beforeEach(() => { mockCreate.mockClear(); says({}); });
afterEach(() => jest.useRealTimers());

describe('a day that does not exist is no date', () => {
  it('on a customer\'s purchase order', () => {
    const { normaliseDraft } = require('../../utils/inboundPoOcr');
    expect(normaliseDraft({ poDate: '2026-11-31', deliveryDate: '2026-02-30', lines: [] })).toMatchObject({ poDate: null, deliveryDate: null });
    expect(normaliseDraft({ poDate: '2026-11-30', deliveryDate: '2026-12-05', lines: [] })).toMatchObject({ poDate: '2026-11-30', deliveryDate: '2026-12-05' });
  });

  it('on a goods receipt, an ID card and a proof of delivery', () => {
    expect(require('../../utils/inwardOcr').normalise({ date: '2026-02-30', lines: [] }).date).toBeNull();
    expect(require('../../utils/inwardOcr').normalise({ date: '2026-02-28', lines: [] }).date).toBe('2026-02-28');
    expect(require('../../utils/kycOcr').normaliseId({ kind: 'aadhaar', name: 'R. Murugan', dob: '1990-02-30' }).dob).toBe('');
    expect(require('../../utils/kycOcr').normaliseId({ kind: 'aadhaar', name: 'R. Murugan', dob: '1990-03-12' }).dob).toBe('1990-03-12');
    expect(require('../../utils/podOcr').normalisePod({ dcNumber: 'E-12', deliveredOn: '2026-04-31' }).deliveredOn).toBe('');
    expect(require('../../utils/podOcr').normalisePod({ dcNumber: 'E-12', deliveredOn: '2026-04-30' }).deliveredOn).toBe('2026-04-30');
  });

  it('and a notice\'s financial year is one that exists', () => {
    const { normaliseNotice } = require('../../utils/noticeOcr');
    expect(normaliseNotice({ authority: 'gst', form: 'ASMT-10', financialYear: '2026-28' }).financialYear).toBe('');
    expect(normaliseNotice({ authority: 'gst', form: 'ASMT-10', financialYear: '2024-25' }).financialYear).toBe('2024-25');
  });
});

describe('an order typed on WhatsApp', () => {
  it('is read from today in India, with the weekday', async () => {
    // 01:30 on Saturday the 21st in India is still Friday the 20th in UTC:
    // "by tomorrow" was worked out from the wrong day.
    jest.useFakeTimers({ now: new Date('2026-11-20T20:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    says({ lines: [] });
    await require('../../utils/inboundPoOcr').extractPurchaseOrderText('2000 m 25mm black by tomorrow');
    const prompt = mockCreate.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toMatch(/Today is Saturday, 2026-11-21/);
    expect(prompt).not.toMatch(/2026-11-20/);
  });
});

describe('whose cheque this is', () => {
  const { sameName } = require('../../utils/kycOcr');

  it('is the party\'s when the names agree, whatever is written round them', () => {
    expect(sameName('SRI YARN TRADERS', 'M/s Sri Yarn Traders Pvt Ltd')).toBe(true);
    expect(sameName('Sri Yarn', 'Sri Yarn Traders')).toBe(true);
    expect(sameName('SRIYARN TRADERS', 'Sri Yarn Traders')).toBe(true);
    expect(sameName('KPR', 'KPR Mills Ltd')).toBe(true);                      // short, but a whole word
    expect(sameName('Sunrise Garmnets', 'Sunrise Garments')).toBe(true);     // a slip of the pen
  });

  it('is not, when one is only letters found inside the other', () => {
    expect(sameName('RAJ', 'Rajesh Textiles')).toBe(false);
    expect(sameName('S K', 'Sasikala Yarns')).toBe(false);
    expect(sameName('ANAND', 'Anandhi Mills')).toBe(false);
    expect(sameName('', 'Anandhi Mills')).toBe(false);
  });
});

describe('a quality photo', () => {
  const { classifyDefect } = require('../../utils/qcVision');
  const run = () => classifyDefect(Buffer.from('x'), 'image/jpeg', { name: '25mm Black', parameters: [{ parameter: 'Width', expected: '25mm' }] });

  it('passes only when the model said so', async () => {
    says({ overallResult: 'pass', confidence: 80, results: [{ parameter: 'Width', expected: '25mm', measured: 'about 25mm', pass: true }], notes: 'Clean.' });
    expect(await run()).toMatchObject({ ok: true, overallResult: 'pass' });
  });

  it('fails on "FAIL", on a failed line, on a defect named, and on "false" written as text', async () => {
    says({ overallResult: 'FAIL', confidence: 70, results: [], notes: 'Broken ends.' });
    expect((await run()).overallResult).toBe('fail');
    says({ overallResult: 'pass', confidence: 70, results: [{ parameter: 'Width', expected: '25mm', measured: '22mm', pass: false }] });
    expect((await run()).overallResult).toBe('fail');
    says({ overallResult: 'pass', confidence: 70, results: [{ parameter: 'Width', expected: '25mm', measured: '22mm', pass: 'false' }] });
    const r = await run();
    expect(r.results[0].pass).toBe(false);
    expect(r.overallResult).toBe('fail');
    says({ overallResult: 'pass', confidence: 60, defectCode: 'weave-fault', rejectedMetersHint: 12, results: [] });
    expect((await run()).overallResult).toBe('fail');
    says({ overallResult: 'looks fine to me', confidence: 60, results: [] });
    expect((await run()).ok).toBe(false);                 // no verdict is no draft
  });
});

describe('a paper too long to be read in one go', () => {
  const cut = '{"problem":null,"lines":[{"description":"Nylon 70D","quantity":60,"rate":310},{"description":"Nyl';

  it('says so — the shared reader', async () => {
    says(cut, 'max_tokens');
    const err = await require('../../utils/docRead').readJson({ pages: [photo], prompt: 'read' }).catch((e) => e);
    expect(err.code).toBe('REPLY_CUT');
    expect(err.message).toMatch(/too long to read in one go/i);
    expect(require('../../utils/docRead').failure(err, 'the price list').status).toBe(400);
  });

  it('says so — a supplier\'s bill and a party\'s statement', async () => {
    says(cut, 'max_tokens');
    const bill = await require('../../utils/billOcr').readBill([photo]).catch((e) => e);
    expect(bill.code).toBe('REPLY_CUT');
    const statement = await require('../../utils/partyStatementOcr').readStatement({ files: [photo] }).catch((e) => e);
    expect(statement.code).toBe('REPLY_CUT');
  });

  it('and a reply that ended properly is read as before', async () => {
    says({ kind: 'bill', supplierName: 'Sri Yarn Traders', lines: [{ description: 'Nylon 70D', quantity: 60, rate: 310, amount: 18600 }], totals: {} });
    expect((await require('../../utils/billOcr').readBill([photo])).lines).toHaveLength(1);
    says('not json at all');
    expect((await require('../../utils/docRead').readJson({ pages: [photo], prompt: 'read' })).data).toBeNull();
  });
});
