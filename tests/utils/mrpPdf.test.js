'use strict';

const { buildMrpPdf } = require('../../utils/mrpPdf.js');

const base = {
  jobOrderNo: 5012,
  orderNo: 1042,
  customerName: 'Acme Corp',
  dateLabel: '02 Jul 2026',
  status: 'preparatory',
  productionMode: 'in_house',
  outsourceVendor: '',
  elastics: [{ name: '20mm white knit', quantity: 12000 }],
  materials: [
    { name: 'Spandex 40D', category: 'Yarn', requiredWeight: 24.5, inStock: 100, shortfall: 0 },
    { name: 'Nylon 70D',   category: 'Yarn', requiredWeight: 60,   inStock: 10,  shortfall: 50 },
  ],
};

describe('mrpPdf.buildMrpPdf', () => {
  test('returns a valid PDF buffer for an in-house job', async () => {
    const buf = await buildMrpPdf(base);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('renders an outsourced job (vendor section) without crashing', async () => {
    const buf = await buildMrpPdf({
      ...base, productionMode: 'outsource', outsourceVendor: 'Weavers United',
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('handles a job with no BOM materials resolved', async () => {
    const buf = await buildMrpPdf({ ...base, materials: [], elastics: [] });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('handles many material rows (page-break path)', async () => {
    const materials = Array.from({ length: 60 }, (_, i) => ({
      name: `Material ${i}`, category: 'Yarn',
      requiredWeight: i + 1, inStock: i, shortfall: i > 30 ? 1 : 0,
    }));
    const buf = await buildMrpPdf({ ...base, materials });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
