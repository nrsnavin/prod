'use strict';
// What the model says is cleaned before anyone sees it: dates day-first
// into ISO, vehicle numbers without spaces, phone numbers without +91, a
// GSTIN only when it is one, and nothing at all when nothing was read.

const lr = require('../../utils/lrOcr');
const card = require('../../utils/partyCardOcr');
const { keywordSeverity } = require('../../services/machineIssueIntake');
const { keywordCategory } = require('../../services/complaintIntake');
const { nameScore } = require('../../services/partyMatch');

describe('lorry receipt read', () => {
  it('cleans figures and refuses an invented date', () => {
    const r = lr.normalise({ lrNumber: ' TPR/4471 ', lrDate: '2026-02-30', vehicleNo: 'tn 38 ab-1234', freight: '4,200', packages: '14', paidBy: 'to_pay', transporterGstin: 'bad' });
    expect(r).toMatchObject({ problem: null, lrNumber: 'TPR/4471', lrDate: null, vehicleNo: 'TN38AB1234', freight: 4200, packages: 14, paidBy: 'to_pay', transporterGstin: '' });
    expect(lr.normalise({}).problem).toBe('unreadable');
    expect(lr.normalise({ problem: 'not_an_lr' }).problem).toBe('not_an_lr');
  });
});

describe('visiting card read', () => {
  it('keeps a real phone, email and GSTIN, and says whether the check digit holds', () => {
    const r = card.normalise({ name: 'Sunrise Garments', phone: '+91 98765 43210', email: 'KUMAR@Sunrise.in', gstin: '27aapfu0939f1zv', pincode: '641 601' });
    expect(r).toMatchObject({ phone: '9876543210', email: 'kumar@sunrise.in', gstin: '27AAPFU0939F1ZV', gstinChecksumOk: true, stateCode: '27', pincode: '641601' });
    expect(card.normalise({ name: '', phone: '12' }).problem).toBe('unreadable');
    expect(card.gstinInfo('29AAGCB7383J1Z4').checksumOk).toBe(true);
  });
});

describe('without a model', () => {
  it('reads the severity and the category from the words', () => {
    expect(keywordSeverity('loom stopped, not running')).toBe('high');
    expect(keywordSeverity('motor la smoke varudhu')).toBe('critical');
    expect(keywordSeverity('small noise on head 2')).toBe('medium');
    expect(keywordCategory('colour is different from sample')).toBe('shade');
    expect(keywordCategory('received 200 meters less')).toBe('quantity');
    expect(keywordCategory('goods not received yet, very late')).toBe('delivery');
  });
  it('a firm entered twice is the same name once the suffixes go', () => {
    expect(nameScore('M/s. Sunrise Garments Pvt Ltd', 'SUNRISE GARMENT')).toBe(1);
    expect(nameScore('Sri Yarn Traders 1', 'Sri Yarn Traders 2')).toBeLessThan(0.75);
  });
});
