'use strict';
// ══════════════════════════════════════════════════════════════════
//  INVOICE AND CHALLAN ON A FULL A4 SHEET
//
//  The header sits at the top as it always has. The table's totals and
//  everything under them (the tax summary, notes, bank, signatures) sit
//  at the foot of the sheet, and the table's column rules run down the
//  space between, so two lines fill the page as a dozen do.
//
//    • 2 and 12 lines: one page, the foot ending at the foot of the sheet
//    • a long one: the foot at the foot of its last page, with rows above
//      it — never a page holding only an empty table and the totals
//    • the same for the delivery challan
// ══════════════════════════════════════════════════════════════════

const { invoiceLayout } = require('../../utils/invoicePdf');
const { challanLayout } = require('../../utils/challanPdf');

const r2 = (n) => Math.round(n * 100) / 100;
const NAMES = ['20mm Knitted Elastic, white', '25mm Knitted Elastic, black', '30mm Woven Elastic, white', '40mm Jacquard Waistband Elastic, logo woven',
  '12mm Braided Elastic, white', '6mm Round Cord Elastic, black', '10mm Shoulder Strap Elastic, plush back', '18mm Fold-over Elastic, matte'];

function invoice(n) {
  const lines = Array.from({ length: n }, (_, i) => {
    const quantity = 1000 + (i * 731) % 6000;
    const rate = [4.2, 5.1, 7.8, 18.5][i % 4];
    const taxable = r2(quantity * rate);
    const half = r2(taxable * 0.025);
    return { name: NAMES[i % NAMES.length], hsn: '5806', unit: 'm', quantity, boxes: 5 + (i % 9), rate, gstPercent: 5, taxable, cgst: half, sgst: half, igst: 0, amount: r2(taxable + 2 * half) };
  });
  const sum = (k) => r2(lines.reduce((a, l) => a + l[k], 0));
  const exact = sum('amount');
  return {
    invoiceNumber: 'INV/2026-27/0001', invoiceDate: '2026-11-13', dueDate: '2026-12-13', status: 'issued', supplyType: 'intra', placeOfSupply: '33',
    customerPo: 'PO-77', orderNo: 1, dcs: [{ dcNumber: 'E-26/27-0001' }], totalBoxes: lines.reduce((a, l) => a + l.boxes, 0),
    seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road, Perundurai', city: 'Erode', pincode: '638052', stateCode: '33' },
    buyer: { name: 'Sunrise Garments', gstin: '33AAEPS1111F1Z2', address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604', stateCode: '33' },
    lines,
    totals: { taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: 0, tax: r2(sum('cgst') + sum('sgst')), roundOff: r2(Math.round(exact) - exact), grand: Math.round(exact) },
    amountInWords: 'Rupees Some Amount Only',
  };
}

const settings = { invoice: { bank: { name: 'State Bank of India', account: '1234567890', ifsc: 'SBIN0001234', branch: 'Erode', upiId: 'balu@sbi' } } };
const branding = { company: 'Balu Elastics', addressLines: ['12 Mill Road', 'Perundurai'], gstin: '33AAECB1234F1Z5', phone: '9876543210' };

function challan(n) {
  const items = Array.from({ length: n }, (_, i) => ({ elasticName: NAMES[i % NAMES.length], unit: 'm', quantity: 1000 + i * 37, boxes: 5 + (i % 9), hsn: '5806' }));
  return {
    dcNumber: 'E-26/27-0001', type: 'elastic', status: 'dispatched', dispatchDate: '2026-11-13', orderNo: 1, customerPo: 'PO-77',
    customerName: 'Sunrise Garments', customerAddress: '4 Kongu Nagar, Tiruppur - 641604', customerGstin: '33AAEPS1111F1Z2', customerPhone: '9000000001',
    vehicleNo: 'TN 33 AB 4471', transporter: 'VRL Logistics', remarks: 'Handle rolls flat.',
    items, totalQuantity: items.reduce((a, i) => a + i.quantity, 0),
  };
}

const atFoot = (layout) => expect(Math.abs(layout.footEnd - layout.bottom)).toBeLessThan(1);

describe('the invoice fills its sheet', () => {
  it.each([1, 2, 12])('%i line(s): one page, the end at the foot of it', async (n) => {
    const layout = await invoiceLayout({ invoice: invoice(n), branding, settings });
    expect(layout.pages).toBe(1);
    atFoot(layout);
  });

  it('a long one ends at the foot of its last page, with rows above the totals', async () => {
    for (const n of [30, 46, 60]) {
      const layout = await invoiceLayout({ invoice: invoice(n), branding, settings });
      expect(layout.pages).toBeGreaterThan(1);
      atFoot(layout);
      expect(layout.rowsOnLastPage).toBeGreaterThan(0);
    }
  });
});

describe('the challan fills its sheet', () => {
  it.each([1, 2, 12])('%i line(s): one page, the foot at the foot of it', async (n) => {
    const layout = await challanLayout({ dc: challan(n), branding, settings: {} });
    expect(layout.pages).toBe(1);
    atFoot(layout);
  });

  it('a long one ends at the foot of its last page, with rows above the totals', async () => {
    for (const n of [40, 55, 70]) {
      const layout = await challanLayout({ dc: challan(n), branding, settings: {} });
      expect(layout.pages).toBeGreaterThan(1);
      atFoot(layout);
      expect(layout.rowsOnLastPage).toBeGreaterThan(0);
    }
  });
});
