'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MACHINE PART SENT OUT IS NOT GOODS DISPATCHED
//
//  A challan is either for elastic going to a customer or for a machine
//  part going out (to a repairer, say) — api/deliveryChallan.js `type`.
//  Invoices are raised only against the first, and the customer's portal
//  shows only the first. The figures that say what was DISPATCHED did not
//  look: a gearbox sent for repair with a declared value was
//
//    • in the morning digest's "Dispatched: ₹… · n DC(s)"
//    • in the evening report's deliveries, its "1" added to the metres
//    • in the Dispatch & sales report — value, quantity, by day, by
//      customer, by item — and the report engine's dispatch dataset
//
//  Found reading utils/digest.js line by line.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
const NOW = new Date('2026-11-20T04:00:00Z');        // 09:30 on the 20th in India
const YESTERDAY = new Date('2026-11-19T06:00:00Z');  // 11:30 on the 19th
const TODAY = new Date('2026-11-20T02:00:00Z');      // 07:30 on the 20th

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require('../../models/DeliveryChallan.js');
  const customer = new mongoose.Types.ObjectId();
  const elastic = new mongoose.Types.ObjectId();
  const goods = (dcNumber, dispatchDate) => ({ dcNumber, type: 'elastic', status: 'dispatched', dispatchDate, customer, customerName: 'Aravind Garments', totalQuantity: 1000, totalAmount: 50000, items: [{ elastic, elasticName: '25mm Woven', unit: 'm', quantity: 1000, rate: 50, amount: 50000 }] });
  const part = (dcNumber, dispatchDate) => ({ dcNumber, type: 'machine_part', status: 'dispatched', dispatchDate, customerName: 'Kovai Gear Works', totalQuantity: 1, totalAmount: 80000, items: [{ description: 'Loom gearbox, for repair', unit: 'nos', quantity: 1, rate: 80000, amount: 80000 }] });
  await mongoose.connection.collection('deliverychallans').insertMany([
    goods('E-1', YESTERDAY), part('M-1', YESTERDAY),
    goods('E-2', TODAY), part('M-2', TODAY),
    // A challan from before challans had a type is goods.
    { ...goods('E-0', YESTERDAY), type: undefined },
  ]);
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('what was dispatched leaves out machine parts sent out', () => {
  it('in the morning digest', async () => {
    const { buildDigestData } = require('../../utils/digest.js');
    const { commercial } = await buildDigestData(NOW);
    expect(commercial).toMatchObject({ dispatchDcs: 2, dispatchValue: 100000 });
  });

  it('in the evening report', async () => {
    const { buildEveningReportData } = require('../../utils/eveningReport.js');
    const { deliveries } = await buildEveningReportData(NOW);
    expect(deliveries).toMatchObject({ count: 1, totalQuantity: 1000, totalAmount: 50000 });
    expect(deliveries.items.map((d) => d.dcNumber)).toEqual(['E-2']);
  });

  it('in the dispatch and sales report, however it is grouped', async () => {
    const { dispatchReport } = require('../../services/reports/dispatchReport.js');
    const from = new Date('2026-11-18T18:30:00Z');
    const to = new Date('2026-11-20T18:30:00Z');
    for (const groupBy of ['customer', 'elastic', 'day']) {
      const r = await dispatchReport({ from, to, groupBy });
      expect(r.summary).toMatchObject({ dcs: 3, quantity: 3000, amount: 150000 });
      expect(JSON.stringify(r.rows)).not.toMatch(/Kovai|gearbox/i);
      expect(r.rows.reduce((s, x) => s + (x.amount || 0), 0)).toBe(150000);
    }
  });

  it('in the report engine\'s dispatch lines', async () => {
    const { DATASETS } = require('../../services/reportEngine/datasets.js');
    const rows = await DATASETS.dispatch.rows({ from: new Date('2026-11-18T18:30:00Z'), to: new Date('2026-11-20T18:30:00Z') });
    expect(rows.map((r) => r.dcNumber).sort()).toEqual(['E-0', 'E-1', 'E-2']);
  });
});
