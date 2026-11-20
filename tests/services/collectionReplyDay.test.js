'use strict';
// A customer's reply on WhatsApp, read on the day it is in India.
//
// "Will pay tomorrow", sent at a quarter to two in the morning, was a
// promise for TODAY: the reader took today from the server's clock, which
// is kept on UTC and does not turn until 05:30 in India. The model was
// told the same wrong day, and the weekday with it. And the day the model
// gave back was taken on its shape alone: "2026-11-31" became a promise
// for the 1st of December, and a promise dated last year was kept as one
// already broken.

process.env.NODE_ENV = 'test';

let mockSays = null;
let mockAsked = '';
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockSays ? { messages: { create: async (req) => { mockAsked = req.messages[0].content; return { content: [{ type: 'text', text: JSON.stringify(mockSays) }], usage: {} }; } } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));
jest.mock('../../services/aiLedger', () => ({ record: jest.fn(async () => null) }));

const reply = require('../../services/collectionReply');

/** 01:45 on Friday 6 November 2026 in India; the server's clock still says Thursday the 5th, 20:15. */
const NIGHT = new Date('2026-11-05T20:15:00Z');
/** The same Friday, mid-afternoon. */
const AFTERNOON = new Date('2026-11-06T09:00:00Z');
const day = (d) => (d ? d.toISOString().slice(0, 10) : null);

beforeEach(() => { mockSays = null; mockAsked = ''; });

describe('the day a reply names, counted from today in India', () => {
  it.each([
    ['will pay tomorrow', '2026-11-07'],
    ['payment today itself sir', '2026-11-06'],
    ['day after tomorrow', '2026-11-08'],
    ['will pay by monday', '2026-11-09'],
    ['will pay on friday', '2026-11-13'],          // today is Friday: the next one
    ['next week', '2026-11-13'],
    ['month end', '2026-11-30'],
    ['will pay by 6th', '2026-11-06'],
    ['will pay by 5th', '2026-12-05'],             // the 5th has gone, in India
    ['on 6/11', '2026-11-06'],
    ['on 5/11', '2027-11-05'],
  ])('%s', (text, want) => {
    expect(day(reply.dateIn(text, NIGHT))).toBe(want);
    // The same answer at any hour of that day.
    expect(day(reply.dateIn(text, AFTERNOON))).toBe(want);
  });

  it('a day written as one that does not exist is no day', () => {
    expect(reply.dateIn('on 31/11', AFTERNOON)).toBeNull();
    expect(reply.dateIn('on 5/13', AFTERNOON)).toBeNull();   // was the 5th of January
    expect(reply.dateIn('on 30/02/2027', AFTERNOON)).toBeNull();
  });

  it('a promise read by its words carries that day', () => {
    expect(reply.keywordRead('will transfer 1.5 lakh tomorrow', NIGHT)).toMatchObject({ kind: 'promise', date: '2026-11-07', amount: 150000 });
  });
});

describe('what the model is told, and what is taken from it', () => {
  it('is told the day and the weekday it is in India', async () => {
    mockSays = { kind: 'promise', date: '2026-11-07', amount: 50000, reference: '', summary: 'Will pay 50,000 tomorrow' };
    const read = await reply.readReply('naalaikku 50000 anuppuren', { today: NIGHT });
    expect(mockAsked).toContain('Today is 2026-11-06 (friday)');
    expect(read).toMatchObject({ kind: 'promise', date: '2026-11-07', amount: 50000, ai: true });
  });

  it('a day that does not exist is not taken: the words of the reply decide', async () => {
    mockSays = { kind: 'promise', date: '2026-11-31', amount: null, reference: '', summary: 'Will pay at month end' };
    expect(await reply.readReply('will pay by month end', { today: AFTERNOON })).toMatchObject({ kind: 'promise', date: '2026-11-30' });
    mockSays = { kind: 'promise', date: '2026-02-30', amount: null, reference: '', summary: 'Will pay' };
    expect(await reply.readReply('we will pay sir', { today: AFTERNOON })).toMatchObject({ kind: 'promise', date: null });
  });

  it('a promise is not for a day that has gone', async () => {
    // "On the 15th" from a model that slipped a year.
    mockSays = { kind: 'promise', date: '2025-11-15', amount: 50000, reference: '', summary: 'Will pay on the 15th' };
    expect(await reply.readReply('will pay Rs 50000 on 15th', { today: AFTERNOON })).toMatchObject({ kind: 'promise', date: '2026-11-15' });
    // Nothing in the words either: kept as said, with no day.
    mockSays = { kind: 'promise', date: '2026-11-05', amount: null, reference: '', summary: 'Will pay' };
    expect(await reply.readReply('we will arrange', { today: NIGHT })).toMatchObject({ kind: 'promise', date: null });
    // Today is not gone.
    mockSays = { kind: 'promise', date: '2026-11-06', amount: null, reference: '', summary: 'Will pay today' };
    expect(await reply.readReply('we will arrange', { today: NIGHT })).toMatchObject({ kind: 'promise', date: '2026-11-06' });
  });

  it('a payment already made keeps the day it was made', async () => {
    mockSays = { kind: 'paid', date: '2026-11-03', amount: 50000, reference: 'HDFC000123456789', summary: 'Paid on the 3rd' };
    expect(await reply.readReply('paid on 3rd UTR HDFC000123456789', { today: AFTERNOON })).toMatchObject({ kind: 'paid', date: '2026-11-03' });
  });
});
