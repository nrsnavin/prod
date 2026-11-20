'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE REPORT QUERY'S OWN RULES — found reading services/reportEngine
//
//    • a blank is not "before" anything: an order with no supply date is
//      not "to supply before 1 December", a bill with no due date is not
//      "due by today". Blanks compared as the lowest value there is, so
//      every <, <= and BETWEEN from the start let them through.
//    • a date in a condition has to be a day that exists
//    • LIMIT has to be a number (LIMIT 'abc' gave one row)
// ══════════════════════════════════════════════════════════════════

const { DATASETS } = require('../../../services/reportEngine/datasets');
const { run } = require('../../../services/reportEngine/query');
const { parse } = require('../../../services/reportEngine/sql');

const ROWS = [
  { date: '2026-11-03', orderNo: '1', supplyDate: '2026-11-20', days: 4, value: 100 },
  { date: '2026-11-05', orderNo: '2', supplyDate: '', days: null, value: 200 },
  { date: '2026-11-09', orderNo: '3', supplyDate: '2026-12-15', days: 0, value: 300 },
];

beforeAll(() => {
  DATASETS.zz_probe = {
    label: 'Probe', access: ['admin'], dated: false, description: '',
    fields: {
      date: { label: 'Date', type: 'date' }, orderNo: { label: 'Order', type: 'text' }, supplyDate: { label: 'Supply by', type: 'date' },
      days: { label: 'Days', type: 'number', agg: 'max' }, value: { label: 'Value', type: 'money', agg: 'sum' },
    },
    rows: async () => ROWS.map((r) => ({ ...r })),
  };
});
afterAll(() => { delete DATASETS.zz_probe; });

const orders = async (sql) => (await run(parse(sql), { role: 'admin' })).rows.map((r) => r.orderNo).sort();

describe('a blank is not less than anything', () => {
  it('a date left blank is not before a day, nor between two', async () => {
    expect(await orders("SELECT order_no FROM zz_probe WHERE supply_by < '2026-12-01'")).toEqual(['1']);
    expect(await orders("SELECT order_no FROM zz_probe WHERE supply_by <= '2026-12-15'")).toEqual(['1', '3']);
    expect(await orders("SELECT order_no FROM zz_probe WHERE supply_by BETWEEN '2026-01-01' AND '2026-12-31'")).toEqual(['1', '3']);
    expect(await orders("SELECT order_no FROM zz_probe WHERE supply_by > '2026-12-01'")).toEqual(['3']);
  });

  it('a number left blank is not under a limit — and zero still is', async () => {
    expect(await orders('SELECT order_no FROM zz_probe WHERE days < 5')).toEqual(['1', '3']);
    expect(await orders('SELECT order_no FROM zz_probe WHERE days <= 0')).toEqual(['3']);
    expect(await orders('SELECT order_no FROM zz_probe WHERE days >= 0')).toEqual(['1', '3']);
    expect(await orders('SELECT order_no FROM zz_probe WHERE days BETWEEN 0 AND 10')).toEqual(['1', '3']);
  });

  it('the blanks are still there to ask for by name', async () => {
    expect(await orders('SELECT order_no FROM zz_probe WHERE supply_by IS NULL')).toEqual(['2']);
    expect(await orders('SELECT order_no FROM zz_probe WHERE days IS NULL')).toEqual(['2']);
    expect(await orders('SELECT order_no FROM zz_probe')).toEqual(['1', '2', '3']);
  });
});

describe('what a query may hold', () => {
  it('a LIMIT that is not a number is refused, not read as one row', async () => {
    await expect(run({ dataset: 'zz_probe', select: ['orderNo'], limit: 'abc' }, { role: 'admin' })).rejects.toThrow(/LIMIT/);
    await expect(run({ dataset: 'zz_probe', select: ['orderNo'], limit: 0 }, { role: 'admin' })).rejects.toThrow(/LIMIT/);
    expect((await run({ dataset: 'zz_probe', select: ['orderNo'], limit: 2 }, { role: 'admin' })).rows).toHaveLength(2);
    expect((await run({ dataset: 'zz_probe', select: ['orderNo'], limit: '2' }, { role: 'admin' })).rows).toHaveLength(2);
    expect((await run({ dataset: 'zz_probe', select: ['orderNo'] }, { role: 'admin' })).rows).toHaveLength(3);
  });

  it('a date condition needs a day that exists', async () => {
    const dated = (sql) => run(parse(sql), { role: 'admin', from: new Date('2026-10-31T18:30:00Z'), to: new Date('2026-11-30T18:30:00Z') });
    DATASETS.zz_probe.dated = true;
    try {
      await expect(dated("SELECT order_no FROM zz_probe WHERE date >= '2026-02-30'")).rejects.toThrow(/not a date/);
      await expect(dated("SELECT order_no FROM zz_probe WHERE date BETWEEN '2026-04-01' AND '2026-04-31'")).rejects.toThrow(/not a date/);
      expect((await dated("SELECT order_no FROM zz_probe WHERE date >= '2026-11-04'")).rows).toHaveLength(2);
    } finally { DATASETS.zz_probe.dated = false; }
  });
});
