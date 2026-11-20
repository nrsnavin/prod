'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DASHBOARD'S DAYS — found reading services/dashboardOverview.js
//
//    • "Sales this month" stopped at the present moment, and an invoice
//      is dated at its day's UTC midnight: from midnight to 05:30 in
//      India, the invoices raised today were not in the figure.
//    • The floor's metres per day keyed a shift plan by the server's
//      date. A plan kept the older way, at 00:00 IST, is 18:30 UTC the
//      evening before — so one factory day was two here, each with half
//      its metres, and the average per working day came out low.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, overview;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ overview } = require('../../services/dashboardOverview'));
}, 60_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of ['invoices', 'shiftplans', 'machines']) await mongoose.connection.collection(c).deleteMany({});
});

describe('sales this month', () => {
  it('includes the invoices dated today, at any hour of today', async () => {
    const inv = (invoiceNumber, day, grand) => ({ invoiceNumber, status: 'issued', invoiceDate: new Date(`${day}T00:00:00Z`), totals: { grand }, paidAmount: grand, buyer: { name: 'A' } });
    await mongoose.connection.collection('invoices').insertMany([
      inv('I/1', '2026-11-03', 10000),
      inv('I/2', '2026-11-21', 5000),       // raised today
      inv('I/3', '2026-11-22', 700),        // dated tomorrow: not yet
      inv('I/4', '2026-10-05', 4000),       // last month, by the 21st
      inv('I/5', '2026-10-25', 9000),       // last month, after the 21st
    ]);
    // 21 Nov 2026, 01:30 in India — 20:00 on the 20th by the server's clock.
    const early = await overview('admin', { now: new Date('2026-11-20T20:00:00Z') });
    expect(early.money.sales).toMatchObject({ monthToDate: 15000, invoices: 2, lastMonthSameDays: 4000, throughDay: 21 });
    // And the same answer in the afternoon.
    const later = await overview('admin', { now: new Date('2026-11-21T09:00:00Z') });
    expect(later.money.sales).toMatchObject({ monthToDate: 15000, invoices: 2, lastMonthSameDays: 4000 });
  });
});

describe('metres per working day', () => {
  it('counts a factory day once, however its shift plans were dated', async () => {
    await mongoose.connection.collection('shiftplans').insertMany([
      // 19 Nov, day shift, kept at 00:00 IST (the older way)…
      { date: new Date('2026-11-18T18:30:00Z'), shift: 'DAY', totalProduction: 1000 },
      // …and its night shift, kept at the day's UTC midnight.
      { date: new Date('2026-11-19T00:00:00Z'), shift: 'NIGHT', totalProduction: 800 },
      // 18 Nov, both the newer way.
      { date: new Date('2026-11-18T00:00:00Z'), shift: 'DAY', totalProduction: 900 },
      { date: new Date('2026-11-18T00:00:00Z'), shift: 'NIGHT', totalProduction: 700 },
      // Today so far (20 Nov), the older way.
      { date: new Date('2026-11-19T18:30:00Z'), shift: 'DAY', totalProduction: 120 },
    ]);
    // 20 Nov 2026, 11:30 in India.
    const d = await overview('admin', { now: new Date('2026-11-20T06:00:00Z') });
    expect(d.floor.metres.series).toEqual([{ date: '2026-11-18', metres: 1600 }, { date: '2026-11-19', metres: 1800 }]);
    expect(d.floor.metres).toMatchObject({ today: 120, perWorkingDay: 1700, days: 2 });
  });
});
