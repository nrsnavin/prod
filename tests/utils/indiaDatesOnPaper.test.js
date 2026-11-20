'use strict';
// A moment printed as a date is the day, and the time, it was in India.
//
//  · The invoice's "Ack Date" is when the portal acknowledged the IRN. It
//    was printed off the server's own clock: five and a half hours behind,
//    and the day before for anything acknowledged before 05:30.
//  · A challan raised with no dispatch date is dated the moment it was
//    keyed: one raised at 01:45 on the 14th was a challan of the 13th.
//  · A ledger "to today" likewise.
//  · The portal's own reply ("14/11/2026 01:45:00", India time) was read
//    as the server's time: kept five and a half hours late.
//  · And the first hours of 1 April were still last year's challan series.
//
// Calendar dates (an invoice's date, a due date) print as they always did.

const { buildInvoicePdf } = require('../../utils/invoicePdf');
const { buildChallanPdf } = require('../../utils/challanPdf');
const { buildStatementPdf } = require('../../utils/accountsPdf');
const { readAckDate } = require('../../services/einvoiceProvider');
const { currentFinancialYear, financialYearLong } = require('../../utils/financialYear');
const { pdfText, pdfRuns, hasRow: rowIn } = require('../helpers/pdfText');
const hasRow = (pdf, row) => rowIn(pdfRuns(pdf), row);

/** 01:45 on 14 November 2026 in India: still the 13th, 20:15, on a server kept on UTC. */
const NIGHT = new Date('2026-11-13T20:15:00Z');

const branding = { company: 'Balu Elastics', addressLines: ['12 Mill Road', 'Perundurai'], gstin: '33AAECB1234F1Z5', phone: '9876543210' };
const invoice = (over = {}) => ({
  invoiceNumber: 'INV/2026-27/0001', invoiceDate: '2026-11-13', dueDate: '2026-12-13', status: 'issued', supplyType: 'intra', placeOfSupply: '33',
  seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road, Perundurai', city: 'Erode', pincode: '638052', stateCode: '33' },
  buyer: { name: 'Sunrise Garments', gstin: '33AAEPS1111F1Z2', address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604', stateCode: '33' },
  lines: [{ name: '20mm Knitted Elastic', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, gstPercent: 5, taxable: 10000, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
  totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand: 10500 }, amountInWords: 'Rupees Ten Thousand Five Hundred Only',
  ...over,
});
const challan = (over = {}) => ({
  dcNumber: 'E-26/27-0001', type: 'elastic', status: 'dispatched', orderNo: 1, customerName: 'Sunrise Garments', customerAddress: '4 Kongu Nagar, Tiruppur',
  items: [{ elasticName: '20mm Knitted Elastic', unit: 'm', quantity: 1000, boxes: 5, hsn: '5806' }], totalQuantity: 1000, ...over,
});

describe('the invoice', () => {
  it('prints the Ack Date as the portal gave it: the day and time in India', async () => {
    const pdf = await buildInvoicePdf({ invoice: invoice({ einvoice: { status: 'registered', irn: 'a'.repeat(64), ackNo: '112010012345678', ackDate: NIGHT, signedQr: 'x.y.z' } }), branding, settings: {} });
    expect(hasRow(pdf, ['Ack Date', '14/11/2026 01:45'])).toBe(true);
    expect(pdfText(pdf)).not.toContain('13/11/2026 20:15');
  });

  it('and its own dates as they are', async () => {
    const pdf = await buildInvoicePdf({ invoice: invoice(), branding, settings: {} });
    expect(hasRow(pdf, ['Invoice Date', '13/11/2026'])).toBe(true);
    expect(hasRow(pdf, ['Due Date', '13/12/2026'])).toBe(true);
  });
});

describe('the challan', () => {
  it('raised in the small hours is dated that day', async () => {
    const pdf = await buildChallanPdf({ dc: challan({ dispatchDate: NIGHT }), branding, settings: {} });
    expect(hasRow(pdf, ['Challan Date', '14/11/2026'])).toBe(true);
    const keyed = await buildChallanPdf({ dc: challan({ dispatchDate: undefined, createdAt: NIGHT }), branding, settings: {} });
    expect(hasRow(keyed, ['Challan Date', '14/11/2026'])).toBe(true);
  });

  it('with a dispatch date keeps it', async () => {
    const pdf = await buildChallanPdf({ dc: challan({ dispatchDate: '2026-11-13' }), branding, settings: {} });
    expect(hasRow(pdf, ['Challan Date', '13/11/2026'])).toBe(true);
  });
});

describe('a ledger printed to today', () => {
  afterEach(() => jest.useRealTimers());

  it('says the day it is in India', async () => {
    jest.useFakeTimers({ now: NIGHT, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    const pdf = await buildStatementPdf({ statement: { opening: 0, rows: [], closing: 0, totals: { debit: 0, credit: 0 } }, party: { name: 'Sunrise Garments' }, from: '2026-04-01', branding });
    expect(pdfText(pdf)).toContain('01/04/2026 to 14/11/2026');
  });
});

describe('the portal’s acknowledgement time', () => {
  it('is India’s clock, however it is written', () => {
    expect(readAckDate('14/11/2026 01:45:00').toISOString()).toBe('2026-11-13T20:15:00.000Z');
    expect(readAckDate('2026-11-14 01:45:00').toISOString()).toBe('2026-11-13T20:15:00.000Z');
    expect(readAckDate('14/11/2026').toISOString()).toBe('2026-11-13T18:30:00.000Z');
    // A moment with its zone is the moment.
    expect(readAckDate('2026-11-13T20:15:00Z').toISOString()).toBe('2026-11-13T20:15:00.000Z');
  });

  it('a date that does not exist is not rolled into another', () => {
    const before = Date.now();
    const got = readAckDate('31/02/2026 10:00:00').getTime();
    expect(got).toBeGreaterThanOrEqual(before);   // "now", as for anything unreadable — not 3 March
  });
});

describe('the financial year of a number', () => {
  it('turns at midnight in India on 1 April', () => {
    expect(currentFinancialYear(new Date('2026-03-31T18:00:00Z'))).toBe('25/26');   // 23:30 on 31 March
    expect(currentFinancialYear(new Date('2026-03-31T19:00:00Z'))).toBe('26/27');   // 00:30 on 1 April
    expect(financialYearLong(new Date('2026-03-31T19:00:00Z'))).toBe('2026-27');
  });

  it('a calendar date is in its own year', () => {
    expect(currentFinancialYear(new Date('2026-03-31T00:00:00Z'))).toBe('25/26');
    expect(currentFinancialYear(new Date('2026-04-01T00:00:00Z'))).toBe('26/27');
    expect(financialYearLong(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
  });
});
