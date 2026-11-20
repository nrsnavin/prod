'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DATE READ OFF A PAPER THAT IS NOT A DAY IS "NOT READ"
//
//  Found reading the paper readers after utils/factoryDay.js stopped
//  taking "31 April" for the 1st of May (tests/utils/realDays.test.js).
//
//  Six readers (bills, slips, payment advices, LRs, party statements,
//  the e-invoice QR) each check that a date they were given exists.
//  Four did not: they asked only whether JavaScript could make a date of
//  it, and JavaScript makes the 1st of May of "2026-04-31".
//
//    utils/paperReaders.js   TDS challans, Form 16A, 26AS, price lists,
//                            power bills, test certificates, debit notes
//    utils/chequeOcr.js      a cheque photographed for a receipt
//    utils/noticeOcr.js      a government notice — and the reply-by day
//                            worked out from it
//    services/cashLine.js    the day the model read off a petty-cash line
//
//  So a cheque misread as dated the 31st of April went into the receipt
//  form as "post-dated to 1 May"; a notice "issued 31/11" had its reply
//  date counted from 1 December. A date that is not a day is now left
//  blank, which is what each of these screens already asks a person to
//  fill in.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../../utils/factoryDay');
const cheque = require('../../utils/chequeOcr');
const notice = require('../../utils/noticeOcr');
const papers = require('../../utils/paperReaders');
const ewaybill = require('../../services/ewaybill');

const NOT_DAYS = ['2026-04-31', '2026-02-30', '2026-11-31', '2026-13-01', '2026-00-10', '2027-02-29'];
const DAYS = ['2026-04-30', '2028-02-29', '2026-11-30'];

describe('one check for "is this text a day"', () => {
  it.each(NOT_DAYS)('%s is not', (s) => expect(factoryDay.isDayKey(s)).toBe(false));
  it.each(DAYS)('%s is', (s) => expect(factoryDay.isDayKey(s)).toBe(true));
  it('only the day written as YYYY-MM-DD, nothing longer or looser', () => {
    for (const v of ['2026-11-20T10:00:00Z', '20/11/2026', '2026-1-5', '', null, undefined, 20261120, new Date()]) expect(factoryDay.isDayKey(v)).toBe(false);
  });
});

describe('a cheque', () => {
  const read = (date) => cheque.normalise({ chequeNo: '123456', date, amount: 25000, amountWords: 'Twenty five thousand only', payee: 'Balu Elastics', drawer: 'Apex Garments' });
  it.each(NOT_DAYS)('dated %s: the date is not read', (s) => {
    // Before: kept, and the receipt drafted for a day in the next month.
    expect(read(s).date).toBe('');
  });
  it.each(DAYS)('dated %s: kept (unchanged)', (s) => expect(read(s).date).toBe(s));
});

describe('a government notice', () => {
  const read = (over) => notice.normaliseNotice({ form: 'ASMT-10', authority: 'gst', ...over });
  it.each(NOT_DAYS)('issued or due on %s: not read, and no reply date is worked out from it', (s) => {
    const n = read({ issuedOn: s, replyBy: s });
    expect(n.issuedOn).toBe('');
    // Before: the impossible day was kept as the deadline.
    expect(n.replyBy).toBe('');
    // ASMT-10 gives 30 days from the day of issue: with no such day, none.
    expect(read({ issuedOn: s }).replyBy).toBe('');
  });
  it('a real day of issue still gives the reply date the law fixes (unchanged)', () => {
    const n = read({ issuedOn: '2026-11-02' });
    expect(n).toMatchObject({ issuedOn: '2026-11-02', replyBy: '2026-12-02', replyByAssumed: true });
  });
});

describe('the other papers', () => {
  it.each(NOT_DAYS)('%s on a challan, a certificate, a price list or a power bill is not read', (s) => expect(papers.isoDate(s)).toBe(''));
  it.each(DAYS)('%s is (unchanged)', (s) => expect(papers.isoDate(s)).toBe(s));
});

// ══════════════════════════════════════════════════════════════════
//  AN E-WAY BILL NUMBER PASTED WITH NO VEHICLE
//
//  Found reading services/ewaybill.js line by line.
//
//  "Leave blank when the transporter adds Part B", says the form. A
//  number pasted from the portal with the vehicle left blank — with the
//  transporter's ID, or with nothing — was refused: "Vehicle number
//  TRANSPORTER is not in the RTO form". The word was a stand-in the code
//  put there to get past one check, and the next check tripped on it.
// ══════════════════════════════════════════════════════════════════
describe('pasting an e-way bill number', () => {
  it('with no vehicle, and with the transporter\'s ID alone', () => {
    for (const body of [{ number: '341012345678' }, { number: '3410 1234 5678', transporterId: '33AAACV1234F1Z5', transporterName: 'VRL Logistics' }]) {
      const doc = {};
      // Before: 400, "Vehicle number TRANSPORTER is not in the RTO form (e.g. TN39BX1234)".
      const d = ewaybill.paste(doc, body);
      expect(d.vehicleNo).toBe('');
      expect(doc.ewaybill).toMatchObject({ status: 'generated', number: '341012345678', vehicleNo: '', provider: 'manual', transporterId: body.transporterId || '' });
    }
  });
  it('a vehicle number, when given, is still held to the RTO form', () => {
    expect(() => ewaybill.paste({}, { number: '341012345678', vehicleNo: 'TN-39' })).toThrow(/Vehicle number TN39 is not in the RTO form/);
    const doc = {};
    ewaybill.paste(doc, { number: '341012345678', vehicleNo: 'tn 39 bx 1234', validUpto: '2026-11-22' });
    expect(doc.ewaybill).toMatchObject({ vehicleNo: 'TN39BX1234' });
  });
  it('a number that is not 12 digits, or one already recorded, is still refused', () => {
    expect(() => ewaybill.paste({}, { number: '12345' })).toThrow(/12 digits/);
    expect(() => ewaybill.paste({ ewaybill: { status: 'generated', number: '341012345678' } }, { number: '341099998888' })).toThrow(/Already recorded/);
  });
  it('generating one still needs the vehicle or the transporter (unchanged)', () => {
    expect(() => ewaybill.readDetails({ mode: 'road' })).toThrow(/vehicle number, or the transporter/);
    expect(ewaybill.readDetails({ mode: 'road', transporterId: '33AAACV1234F1Z5' })).toMatchObject({ vehicleNo: '', transporterId: '33AAACV1234F1Z5' });
  });
  it('a valid-until date that is not a day is refused', () => {
    expect(() => ewaybill.paste({}, { number: '341012345678', validUpto: '2026-11-31' })).toThrow(/validUpto is not a date/);
  });
});
