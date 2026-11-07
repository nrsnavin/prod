'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE READY-MADE REPORTS
//
//  Each is a query over a dataset (services/reportEngine/datasets.js),
//  so it filters, totals and downloads exactly like one typed in the
//  query builder — and "Edit as a query" opens it there to change.
// ══════════════════════════════════════════════════════════════════

const s = (f) => ({ field: f, agg: 'sum' });
const c = (f = '*') => ({ field: f, agg: 'count' });
const n = (f) => ({ field: f, agg: 'countd' }); // how many documents, not lines
const by = (dataset, dims, measures, more = {}) => ({ dataset, select: [...dims, ...measures], groupBy: dims, ...more });

const SALES = [s('quantity'), s('taxable'), s('gst'), s('amount')];
const BUYS = [s('quantity'), s('taxable'), s('gst'), s('amount')];

const REPORTS = [
  // ── Sales ────────────────────────────────────────────────────────
  { id: 'sales-by-customer', group: 'Sales', title: 'Sales by customer', description: 'Invoiced value and metres per customer.', query: by('sales', ['customer'], [n('invoiceNo'), ...SALES]) },
  { id: 'sales-by-item', group: 'Sales', title: 'Sales by item', description: 'Each elastic sold: metres, value and average rate.', query: by('sales', ['elastic'], [s('quantity'), { field: 'rate', agg: 'avg' }, s('taxable'), s('amount')]) },
  { id: 'sales-by-customer-group', group: 'Sales', title: 'Sales by customer group', description: 'Customers grouped as you set them on the customer.', query: by('sales', ['customerGroup'], SALES) },
  { id: 'sales-by-elastic-group', group: 'Sales', title: 'Sales by elastic group', description: 'Elastics by their group (a customer\'s own group first).', query: by('sales', ['elasticGroup'], SALES) },
  { id: 'sales-customer-item', group: 'Sales', title: 'Sales by customer and item', description: 'Who bought which elastic.', query: by('sales', ['customer', 'elastic'], [s('quantity'), s('taxable')], { orderBy: [{ key: 'customer' }, { key: 'sum_taxable', dir: 'desc' }] }) },
  { id: 'sales-by-month', group: 'Sales', title: 'Sales by month', description: 'Month by month.', query: by('sales', ['month'], SALES, { orderBy: [{ key: 'month' }] }) },
  { id: 'sales-by-state', group: 'Sales', title: 'Sales by state', description: 'By the buyer\'s GST state code.', query: by('sales', ['state'], SALES) },
  { id: 'sales-by-hsn', group: 'Sales', title: 'Sales by HSN', description: 'HSN-wise summary, as GSTR-1 asks.', query: by('sales', ['hsn'], SALES) },
  { id: 'sales-register', group: 'Sales', title: 'Sales register', description: 'Invoice by invoice.', query: by('sales', ['invoiceNo', 'date', 'customer'], [s('taxable'), s('gst'), s('amount')], { orderBy: [{ key: 'date', dir: 'desc' }] }) },

  // ── Purchases ────────────────────────────────────────────────────
  { id: 'purchases-by-item', group: 'Purchases', title: 'Purchases by item', description: 'Each material bought: quantity, value and average rate.', query: by('purchases', ['material'], [s('quantity'), { field: 'rate', agg: 'avg' }, s('taxable'), s('amount')]) },
  { id: 'purchases-by-supplier', group: 'Purchases', title: 'Purchases by supplier', description: 'Billed value per supplier.', query: by('purchases', ['supplier'], [n('billNo'), ...BUYS]) },
  { id: 'purchases-by-category', group: 'Purchases', title: 'Purchases by category', description: 'Warp, weft, rubber, covering, packing…', query: by('purchases', ['category'], BUYS) },
  { id: 'purchases-by-material-group', group: 'Purchases', title: 'Purchases by material group', description: 'By your own material groups.', query: by('purchases', ['materialGroup'], BUYS) },
  { id: 'purchases-supplier-item', group: 'Purchases', title: 'Purchases by supplier and item', description: 'Who supplied which material, at what rate.', query: by('purchases', ['supplier', 'material'], [s('quantity'), { field: 'rate', agg: 'avg' }, s('taxable')], { orderBy: [{ key: 'supplier' }, { key: 'sum_taxable', dir: 'desc' }] }) },
  { id: 'purchases-by-month', group: 'Purchases', title: 'Purchases by month', description: 'Month by month.', query: by('purchases', ['month'], BUYS, { orderBy: [{ key: 'month' }] }) },
  { id: 'purchase-register', group: 'Purchases', title: 'Purchase register', description: 'Bill by bill.', query: by('purchases', ['billNo', 'supplierBillNo', 'date', 'supplier'], [s('taxable'), s('gst'), s('amount')], { orderBy: [{ key: 'date', dir: 'desc' }] }) },
  { id: 'grn-by-material', group: 'Purchases', title: 'Goods received by material', description: 'Received into stores, by material.', query: by('goods_received', ['material'], [s('quantity'), s('value')]) },
  { id: 'grn-by-supplier', group: 'Purchases', title: 'Goods received by supplier', description: 'Received into stores, by supplier.', query: by('goods_received', ['supplier'], [s('quantity'), s('value')]) },

  // ── Production ───────────────────────────────────────────────────
  { id: 'production-by-machine', group: 'Production', title: 'Production by machine', description: 'Verified metres per loom.', query: by('production', ['machine'], [s('metres'), s('shifts')], { orderBy: [{ key: 'sum_metres', dir: 'desc' }] }) },
  { id: 'production-by-operator', group: 'Production', title: 'Production by operator', description: 'Verified metres per operator.', query: by('production', ['operator'], [s('metres'), s('shifts')]) },
  { id: 'production-by-shift', group: 'Production', title: 'Production by shift', description: 'Day against night.', query: by('production', ['shift'], [s('metres'), s('shifts')]) },
  { id: 'production-by-elastic', group: 'Production', title: 'Production by elastic', description: 'Metres woven per elastic.', query: by('production', ['elastic'], [s('metres')]) },
  { id: 'production-by-day', group: 'Production', title: 'Production by day', description: 'Day by day.', query: by('production', ['date'], [s('metres'), s('shifts')], { orderBy: [{ key: 'date' }] }) },
  { id: 'production-by-job', group: 'Production', title: 'Production by job', description: 'Metres woven per job.', query: by('production', ['jobNo'], [s('metres')]) },
  { id: 'production-machine-day', group: 'Production', title: 'Production by machine and day', description: 'Each loom, each day.', query: by('production', ['date', 'machine'], [s('metres')], { orderBy: [{ key: 'date' }, { key: 'machine' }] }) },
  { id: 'production-by-month', group: 'Production', title: 'Production by month', description: 'Month by month.', query: by('production', ['month'], [s('metres'), s('shifts')], { orderBy: [{ key: 'month' }] }) },
  { id: 'downtime-by-reason', group: 'Production', title: 'Downtime by reason', description: 'Minutes lost, from the shift remarks.', query: by('production', ['downtimeKind'], [s('downtimeMinutes'), c('downtimeKind')], { where: [{ field: 'downtimeKind', op: 'not empty' }] }) },
  { id: 'wastage-by-elastic', group: 'Production', title: 'Wastage by elastic', description: 'Wastage recorded per elastic.', query: by('wastage', ['elastic'], [s('quantity'), s('penalty')]) },
  { id: 'wastage-by-operator', group: 'Production', title: 'Wastage by operator', description: 'Wastage and penalties per operator.', query: by('wastage', ['operator'], [s('quantity'), s('penalty')]) },
  { id: 'wastage-by-reason', group: 'Production', title: 'Wastage by reason', description: 'Why it was wasted.', query: by('wastage', ['reason'], [s('quantity'), c()]) },

  // ── Dispatch and orders ──────────────────────────────────────────
  { id: 'dispatch-by-customer', group: 'Dispatch and orders', title: 'Dispatch by customer', description: 'Challans out, per customer.', query: by('dispatch', ['customer'], [n('dcNumber'), s('quantity'), s('amount')]) },
  { id: 'dispatch-by-elastic', group: 'Dispatch and orders', title: 'Dispatch by elastic', description: 'Metres sent, per elastic.', query: by('dispatch', ['elastic'], [s('quantity'), s('amount')]) },
  { id: 'dispatch-register', group: 'Dispatch and orders', title: 'Dispatch register', description: 'Challan by challan.', query: by('dispatch', ['dcNumber', 'date', 'customer', 'status'], [s('quantity'), s('amount')], { orderBy: [{ key: 'date', dir: 'desc' }] }) },
  { id: 'pending-by-customer', group: 'Dispatch and orders', title: 'Pending orders by customer', description: 'What is still to supply, per customer.', query: by('orders', ['customer'], [s('ordered'), s('pending')], { where: [{ field: 'pending', op: '>', value: 0 }] }) },
  { id: 'pending-by-elastic', group: 'Dispatch and orders', title: 'Pending orders by elastic', description: 'What is still to weave, per elastic.', query: by('orders', ['elastic'], [s('pending')], { where: [{ field: 'pending', op: '>', value: 0 }] }) },
  { id: 'orders-by-customer-group', group: 'Dispatch and orders', title: 'Orders by customer group', description: 'Order intake by your customer groups.', query: by('orders', ['customerGroup'], [n('orderNo'), s('ordered'), s('value')]) },

  // ── Stock ────────────────────────────────────────────────────────
  { id: 'stock-summary', group: 'Stock', title: 'Stock summary', description: 'Stock and value per material, today.', query: { dataset: 'stock', select: ['material', 'category', 'unit', 'stock', 'minStock', 'rate', 'value'], orderBy: [{ key: 'value', dir: 'desc' }] } },
  { id: 'stock-by-category', group: 'Stock', title: 'Stock by category', description: 'Value held per category, today.', query: by('stock', ['category'], [s('stock'), s('value')]) },
  { id: 'stock-below-minimum', group: 'Stock', title: 'Below minimum stock', description: 'Materials under their minimum, today.', query: { dataset: 'stock', select: ['material', 'unit', 'stock', 'minStock'], where: [{ field: 'belowMinimum', op: '=', value: 'Yes' }], orderBy: [{ key: 'material' }] } },
  { id: 'issues-by-material', group: 'Stock', title: 'Material issued by material', description: 'What left stores, per material.', query: by('material_issues', ['material'], [s('quantity'), s('value')]) },
  { id: 'issues-by-job', group: 'Stock', title: 'Material issued by job', description: 'Yarn drawn per job.', query: by('material_issues', ['jobNo'], [s('quantity'), s('value')]) },

  // ── Money ────────────────────────────────────────────────────────
  { id: 'receipts-by-customer', group: 'Money', title: 'Receipts by customer', description: 'Money received, per customer.', query: by('vouchers', ['party'], [n('voucherNo'), s('amount')], { where: [{ field: 'kind', op: '=', value: 'Receipt' }] }) },
  { id: 'payments-by-supplier', group: 'Money', title: 'Payments by party', description: 'Money paid out, per party.', query: by('vouchers', ['party'], [n('voucherNo'), s('amount')], { where: [{ field: 'kind', op: '=', value: 'Payment' }] }) },
  { id: 'money-by-mode', group: 'Money', title: 'Receipts and payments by mode', description: 'Cash, bank, UPI, cheque, card.', query: by('vouchers', ['kind', 'mode'], [n('voucherNo'), s('amount')]) },
  { id: 'expenses-by-head', group: 'Money', title: 'Expenses by head', description: 'Spent per expense head.', query: by('expenses', ['head'], [n('expenseNo'), s('amount')]) },
  { id: 'receivables-by-customer', group: 'Money', title: 'Receivables by customer', description: 'Unpaid by customers, today.', query: by('receivables', ['customer'], [s('outstanding'), { field: 'overdueDays', agg: 'max' }]) },
  { id: 'receivables-aging', group: 'Money', title: 'Receivables aging', description: 'Unpaid by how overdue, today.', query: by('receivables', ['bucket'], [n('docNo'), s('outstanding')], { orderBy: [{ key: 'bucket' }] }) },
  { id: 'payables-by-supplier', group: 'Money', title: 'Payables by supplier', description: 'What we owe suppliers, today.', query: by('payables', ['supplier'], [s('outstanding'), { field: 'overdueDays', agg: 'max' }]) },
];

function find(id) { return REPORTS.find((r) => r.id === id) || null; }

module.exports = { REPORTS, find };
