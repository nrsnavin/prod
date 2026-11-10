'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DATA EVERY REPORT IS BUILT FROM
//
//  Each dataset is a flat table: one row per invoice line, bill line,
//  shift, issue, voucher… with every field a report can show, filter or
//  group by, labelled and typed. Reports, the query builder and the SQL
//  box all read these and nothing else, so a figure is worked out one
//  way wherever it is shown.
//
//  dataset.rows({ from, to }) → plain rows. The date window is applied
//  in the database on the dataset's own date; everything else (filters,
//  grouping, totals) is services/reportEngine/query.js.
//
//  Dates are business days in India (IST), as YYYY-MM-DD; `month` is
//  YYYY-MM. Money is rupees; quantities are in the unit beside them.
//  `access` says who may read it: money is for admin and accounts.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const IST = 'Asia/Kolkata';
const day = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: IST }) : '');
const month = (d) => day(d).slice(0, 7);
const { r2 } = require('../../utils/money');
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const model = (name) => mongoose.models[name] || require(`../../models/${name}`);
const ids = (list) => [...new Set(list.filter(Boolean).map(String))].filter((x) => mongoose.isValidObjectId(x));

/** Map of id → document (selected fields) for the ids given. */
async function lookup(name, idList, select) {
  const want = ids(idList);
  if (!want.length) return new Map();
  const rows = await model(name).find({ _id: { $in: want } }).select(select).lean();
  return new Map(rows.map((r) => [String(r._id), r]));
}

const MONEY = ['admin', 'accounts'];
const OPS = ['admin', 'accounts', 'production'];

/** Each elastic's one group: a group for this customer first, else the first common group by name. */
async function elasticGroups() {
  const groups = await model('ElasticGroup').find({ isActive: { $ne: false } }).select('name customer items.elastic').sort({ name: 1 }).lean();
  const common = new Map(); const forCustomer = new Map();
  for (const g of groups) {
    for (const it of g.items || []) {
      const e = String(it.elastic);
      if (g.customer) { const k = `${g.customer}|${e}`; if (!forCustomer.has(k)) forCustomer.set(k, g.name); }
      else if (!common.has(e)) common.set(e, g.name);
    }
  }
  return (elastic, customer) => (elastic ? forCustomer.get(`${customer}|${elastic}`) || common.get(String(elastic)) || 'No group' : 'No group');
}

const F = {
  text: (label, more = {}) => ({ label, type: 'text', ...more }),
  date: (label) => ({ label, type: 'date' }),
  qty: (label) => ({ label, type: 'number', agg: 'sum' }),
  money: (label) => ({ label, type: 'money', agg: 'sum' }),
  num: (label, agg = 'sum') => ({ label, type: 'number', agg }),
};

const DATASETS = {
  sales: {
    label: 'Sales (invoice lines)', access: MONEY, dated: true,
    description: 'Every line of every issued tax invoice. Cancelled invoices are left out.',
    fields: {
      date: F.date('Date'), month: F.text('Month'), invoiceNo: F.text('Invoice'), customer: F.text('Customer'),
      customerGroup: F.text('Customer group'), state: F.text('State code'), item: F.text('Item'), elastic: F.text('Elastic'),
      elasticGroup: F.text('Elastic group'), hsn: F.text('HSN'), unit: F.text('Unit'), orderNo: F.text('Order'),
      quantity: F.qty('Quantity'), rate: F.num('Rate', 'avg'), taxable: F.money('Taxable value'), gst: F.money('GST'), amount: F.money('Amount'),
    },
    async rows({ from, to }) {
      const invs = await model('Invoice').find({ status: 'issued', invoiceDate: { $gte: from, $lt: to } })
        .select('invoiceNumber invoiceDate customer buyer.name buyer.stateCode placeOfSupply orderNo lines').lean();
      const [customers, elastics, groupOf] = await Promise.all([
        lookup('Customer', invs.map((i) => i.customer), 'name group'),
        lookup('Elastic', invs.flatMap((i) => (i.lines || []).map((l) => l.elastic)), 'name'),
        elasticGroups(),
      ]);
      const out = [];
      for (const inv of invs) {
        const c = customers.get(String(inv.customer));
        for (const l of inv.lines || []) {
          out.push({
            date: day(inv.invoiceDate), month: month(inv.invoiceDate), invoiceNo: inv.invoiceNumber,
            customer: c?.name || inv.buyer?.name || '', customerGroup: c?.group || 'No group',
            state: inv.buyer?.stateCode || inv.placeOfSupply || '', item: l.name || '',
            elastic: elastics.get(String(l.elastic))?.name || l.name || '', elasticGroup: groupOf(l.elastic, inv.customer),
            hsn: l.hsn || '', unit: l.unit || 'm', orderNo: inv.orderNo != null ? String(inv.orderNo) : '',
            quantity: r3(l.quantity), rate: r2(l.rate), taxable: r2(l.taxable), gst: r2((l.cgst || 0) + (l.sgst || 0) + (l.igst || 0)), amount: r2(l.amount),
          });
        }
      }
      return out;
    },
  },

  purchases: {
    label: 'Purchases (bill lines)', access: MONEY, dated: true,
    description: 'Every line of every supplier bill entered in Accounts. Cancelled bills are left out.',
    fields: {
      date: F.date('Date'), month: F.text('Month'), billNo: F.text('Bill'), supplierBillNo: F.text('Supplier bill no'), supplier: F.text('Supplier'),
      item: F.text('Item'), material: F.text('Material'), category: F.text('Category'), materialGroup: F.text('Material group'),
      hsn: F.text('HSN'), unit: F.text('Unit'), quantity: F.qty('Quantity'), rate: F.num('Rate', 'avg'),
      taxable: F.money('Taxable value'), gst: F.money('GST'), amount: F.money('Amount'),
    },
    async rows({ from, to }) {
      const bills = await model('SupplierBill').find({ status: { $ne: 'cancelled' }, billDate: { $gte: from, $lt: to } })
        .select('billNo supplierBillNo billDate supplierName lines').lean();
      const mats = await lookup('RawMaterial', bills.flatMap((b) => (b.lines || []).map((l) => l.rawMaterial)), 'name category group');
      const groups = await lookup('MaterialGroup', [...mats.values()].map((m) => m.group), 'name');
      const out = [];
      for (const b of bills) for (const l of b.lines || []) {
        const m = mats.get(String(l.rawMaterial));
        out.push({
          date: day(b.billDate), month: month(b.billDate), billNo: b.billNo || '', supplierBillNo: b.supplierBillNo || '', supplier: b.supplierName || '',
          item: l.description || '', material: m?.name || l.description || '', category: m?.category || 'Not a stock material',
          materialGroup: groups.get(String(m?.group))?.name || 'No group', hsn: l.hsn || '', unit: l.unit || '',
          quantity: r3(l.quantity), rate: r2(l.rate), taxable: r2(l.taxable), gst: r2((l.cgst || 0) + (l.sgst || 0) + (l.igst || 0)), amount: r2(l.amount),
        });
      }
      return out;
    },
  },

  goods_received: {
    label: 'Goods received (material inward)', access: OPS, dated: true,
    description: 'Raw material received into stores against purchase orders.',
    fields: {
      date: F.date('Date'), month: F.text('Month'), material: F.text('Material'), category: F.text('Category'), supplier: F.text('Supplier'),
      poNo: F.text('PO'), lotNo: F.text('Lot'), unit: F.text('Unit'), quantity: F.qty('Quantity'), rate: F.num('Rate', 'avg'), value: F.money('Value'),
    },
    async rows({ from, to }) {
      const ins = await model('MaterialInward').find({ inwardDate: { $gte: from, $lt: to } }).select('rawMaterial purchaseOrder quantity inwardDate unitPrice lotNo').lean();
      const mats = await lookup('RawMaterial', ins.map((i) => i.rawMaterial), 'name category unit');
      const pos = await lookup('PurchaseOrder', ins.map((i) => i.purchaseOrder), 'poNo supplier');
      const sups = await lookup('Supplier', [...pos.values()].map((p) => p.supplier), 'name');
      return ins.map((i) => {
        const m = mats.get(String(i.rawMaterial)); const po = pos.get(String(i.purchaseOrder));
        return {
          date: day(i.inwardDate), month: month(i.inwardDate), material: m?.name || '', category: m?.category || '',
          supplier: sups.get(String(po?.supplier))?.name || '', poNo: po?.poNo != null ? String(po.poNo) : '', lotNo: i.lotNo || '',
          unit: m?.unit || 'kg', quantity: r3(i.quantity), rate: r2(i.unitPrice), value: r2((i.quantity || 0) * (i.unitPrice || 0)),
        };
      });
    },
  },

  production: {
    label: 'Production (verified shifts)', access: OPS, dated: true,
    description: 'Metres from shifts the office has verified. A shift weaving several elastics is split equally across its heads, so every grouping adds up to the same total.',
    fields: {
      date: F.date('Date'), month: F.text('Month'), shift: F.text('Shift'), machine: F.text('Machine'), operator: F.text('Operator'),
      jobNo: F.text('Job'), elastic: F.text('Elastic'), metres: F.qty('Metres'), shifts: F.num('Shifts'),
      downtimeKind: F.text('Downtime reason'), downtimeMinutes: F.qty('Downtime minutes'),
    },
    async rows({ from, to }) {
      const sds = await model('ShiftDetail').find({ status: 'closed', date: { $gte: from, $lt: to } })
        .select('date shift machine employee job elastics productionMeters remark').lean();
      const [machines, emps, jobs, elastics] = await Promise.all([
        lookup('Machine', sds.map((s) => s.machine), 'ID'),
        lookup('Employee', sds.map((s) => s.employee), 'name'),
        lookup('JobOrder', sds.map((s) => s.job), 'jobOrderNo'),
        lookup('Elastic', sds.flatMap((s) => (s.elastics || []).map((h) => h.elastic)), 'name'),
      ]);
      const out = [];
      for (const s of sds) {
        const heads = (s.elastics || []).filter((h) => h.elastic);
        const parts = heads.length ? heads : [{ elastic: null }];
        const share = 1 / parts.length;
        const base = {
          date: day(s.date), month: month(s.date), shift: s.shift === 'NIGHT' ? 'Night' : 'Day',
          machine: machines.get(String(s.machine))?.ID || '', operator: emps.get(String(s.employee))?.name || '',
          jobNo: jobs.get(String(s.job))?.jobOrderNo != null ? `J-${jobs.get(String(s.job)).jobOrderNo}` : '',
        };
        const kind = s.remark?.kind ? String(s.remark.kind).replace(/_/g, ' ') : '';
        parts.forEach((h, i) => out.push({
          ...base, elastic: h.elastic ? (elastics.get(String(h.elastic))?.name || '') : 'Not recorded',
          metres: r2((s.productionMeters || 0) * share), shifts: r3(share),
          // The shift's downtime once, on its first part, so a split shift counts it once.
          downtimeKind: i === 0 ? kind : '', downtimeMinutes: i === 0 ? Number(s.remark?.minutes) || 0 : 0,
        }));
      }
      return out;
    },
  },

  wastage: {
    label: 'Wastage', access: OPS, dated: true,
    description: 'Wastage recorded against jobs, with who and why.',
    fields: { date: F.date('Date'), month: F.text('Month'), elastic: F.text('Elastic'), operator: F.text('Operator'), jobNo: F.text('Job'), reason: F.text('Reason'), quantity: F.qty('Quantity'), penalty: F.money('Penalty') },
    async rows({ from, to }) {
      const ws = await model('Wastage').find({ $or: [{ incidentDate: { $gte: from, $lt: to } }, { incidentDate: null, createdAt: { $gte: from, $lt: to } }] })
        .select('elastic employee job quantity penalty incidentDate createdAt reason').lean();
      const [els, emps, jobs] = await Promise.all([lookup('Elastic', ws.map((w) => w.elastic), 'name'), lookup('Employee', ws.map((w) => w.employee), 'name'), lookup('JobOrder', ws.map((w) => w.job), 'jobOrderNo')]);
      return ws.map((w) => {
        const d = w.incidentDate || w.createdAt;
        return { date: day(d), month: month(d), elastic: els.get(String(w.elastic))?.name || '', operator: emps.get(String(w.employee))?.name || '', jobNo: jobs.get(String(w.job))?.jobOrderNo != null ? `J-${jobs.get(String(w.job)).jobOrderNo}` : '', reason: w.reason || '', quantity: r3(w.quantity), penalty: r2(w.penalty) };
      });
    },
  },

  dispatch: {
    label: 'Dispatch (challan lines)', access: OPS, dated: true,
    description: 'Lines of delivery challans dispatched or delivered. Drafts and cancelled challans are left out.',
    fields: { date: F.date('Date'), month: F.text('Month'), dcNumber: F.text('Challan'), customer: F.text('Customer'), elastic: F.text('Elastic'), status: F.text('Status'), quantity: F.qty('Quantity'), rate: F.num('Rate', 'avg'), amount: F.money('Value') },
    async rows({ from, to }) {
      const dcs = await model('DeliveryChallan').find({ status: { $in: ['dispatched', 'delivered'] }, dispatchDate: { $gte: from, $lt: to } }).select('dcNumber dispatchDate customerName status items').lean();
      const out = [];
      for (const dc of dcs) for (const it of dc.items || []) out.push({ date: day(dc.dispatchDate), month: month(dc.dispatchDate), dcNumber: dc.dcNumber, customer: dc.customerName, elastic: it.elasticName || it.description || '', status: dc.status, quantity: r3(it.quantity), rate: r2(it.rate), amount: r2(it.amount || (it.quantity || 0) * (it.rate || 0)) });
      return out;
    },
  },

  orders: {
    label: 'Orders (ordered lines)', access: OPS, dated: true,
    description: 'What each order asked for, and what is still pending on it. Deleted orders are left out.',
    fields: { date: F.date('Date'), month: F.text('Month'), orderNo: F.text('Order'), po: F.text('Customer PO'), customer: F.text('Customer'), customerGroup: F.text('Customer group'), elastic: F.text('Elastic'), status: F.text('Status'), supplyDate: F.date('Supply by'), ordered: F.qty('Ordered'), pending: F.qty('Pending'), rate: F.num('Rate', 'avg'), value: F.money('Value') },
    async rows({ from, to }) {
      const orders = await model('Order').find({ status: { $ne: 'Deleted' }, date: { $gte: from, $lt: to } }).select('orderNo po date supplyDate customer status elasticOrdered pendingElastic').lean();
      const [customers, els] = await Promise.all([lookup('Customer', orders.map((o) => o.customer), 'name group'), lookup('Elastic', orders.flatMap((o) => (o.elasticOrdered || []).map((l) => l.elastic)), 'name')]);
      const out = [];
      for (const o of orders) {
        const pending = new Map((o.pendingElastic || []).map((p) => [String(p.elastic), p.quantity || 0]));
        const c = customers.get(String(o.customer));
        for (const l of o.elasticOrdered || []) out.push({ date: day(o.date), month: month(o.date), orderNo: o.orderNo != null ? String(o.orderNo) : '', po: o.po || '', customer: c?.name || '', customerGroup: c?.group || 'No group', elastic: els.get(String(l.elastic))?.name || '', status: o.status, supplyDate: day(o.supplyDate), ordered: r3(l.quantity), pending: r3(['Completed', 'Cancelled'].includes(o.status) ? 0 : pending.get(String(l.elastic)) ?? 0), rate: r2(l.rate), value: r2((l.quantity || 0) * (l.rate || 0)) });
      }
      return out;
    },
  },

  material_issues: {
    label: 'Material issued', access: OPS, dated: true,
    description: 'Raw material issued out of stores (to jobs, warping, covering). Reversed issues are left out.',
    fields: { date: F.date('Date'), month: F.text('Month'), material: F.text('Material'), category: F.text('Category'), jobNo: F.text('Job'), type: F.text('Issued for'), lotNo: F.text('Lot'), quantity: F.qty('Quantity'), rate: F.num('Rate', 'avg'), value: F.money('Value') },
    async rows({ from, to }) {
      const outs = await model('MaterialOutward').find({ reversed: { $ne: true }, outwardDate: { $gte: from, $lt: to } }).select('rawMaterial job outwardDate type lotNo quantity unitPrice').lean();
      const [mats, jobs] = await Promise.all([lookup('RawMaterial', outs.map((o) => o.rawMaterial), 'name category'), lookup('JobOrder', outs.map((o) => o.job), 'jobOrderNo')]);
      return outs.map((o) => ({ date: day(o.outwardDate), month: month(o.outwardDate), material: mats.get(String(o.rawMaterial))?.name || '', category: mats.get(String(o.rawMaterial))?.category || '', jobNo: jobs.get(String(o.job))?.jobOrderNo != null ? `J-${jobs.get(String(o.job)).jobOrderNo}` : '', type: o.type || '', lotNo: o.lotNo || '', quantity: r3(o.quantity), rate: r2(o.unitPrice), value: r2((o.quantity || 0) * (o.unitPrice || 0)) }));
    },
  },

  vouchers: {
    label: 'Receipts and payments', access: MONEY, dated: true,
    description: 'Money received and paid (posted vouchers). Cancelled vouchers are left out.',
    fields: { date: F.date('Date'), month: F.text('Month'), kind: F.text('Receipt or payment'), voucherNo: F.text('Voucher'), party: F.text('Party'), partyType: F.text('Party type'), mode: F.text('Mode'), account: F.text('Account'), head: F.text('Head'), amount: F.money('Amount') },
    async rows({ from, to }) {
      const vs = await model('Payment').find({ status: 'posted', date: { $gte: from, $lt: to } }).select('kind voucherNo date partyName partyType mode accountName headName amount').lean();
      return vs.map((v) => ({ date: day(v.date), month: month(v.date), kind: v.kind === 'receipt' ? 'Receipt' : 'Payment', voucherNo: v.voucherNo, party: v.partyName, partyType: v.partyType, mode: v.mode, account: v.accountName || '', head: v.headName || '', amount: r2(v.amount) }));
    },
  },

  expenses: {
    label: 'Expenses', access: MONEY, dated: true,
    description: 'Expenses approved or paid, by head.',
    fields: { date: F.date('Date'), month: F.text('Month'), expenseNo: F.text('Expense'), head: F.text('Head'), payee: F.text('Payee'), description: F.text('Description'), status: F.text('Status'), taxable: F.money('Before tax'), amount: F.money('Amount') },
    async rows({ from, to }) {
      const es = await model('Expense').find({ status: { $in: ['approved', 'paid'] }, date: { $gte: from, $lt: to } }).select('expenseNo date categoryName payeeName description status totals').lean();
      return es.map((e) => ({ date: day(e.date), month: month(e.date), expenseNo: e.expenseNo, head: e.categoryName || '', payee: e.payeeName || '', description: e.description || '', status: e.status, taxable: r2(e.totals?.taxable), amount: r2(e.totals?.grand) }));
    },
  },

  stock: {
    label: 'Raw material stock (today)', access: OPS, dated: false,
    description: 'Stock on hand now, valued at average cost (or the current price when there is none).',
    fields: { material: F.text('Material'), category: F.text('Category'), materialGroup: F.text('Material group'), unit: F.text('Unit'), belowMinimum: F.text('Below minimum'), stock: F.qty('Stock'), minStock: F.qty('Minimum'), rate: F.num('Rate', 'avg'), value: F.money('Value') },
    async rows() {
      const mats = await model('RawMaterial').find({ archived: { $ne: true } }).select('name category group unit stock minStock avgCost price').lean();
      const groups = await lookup('MaterialGroup', mats.map((m) => m.group), 'name');
      return mats.map((m) => { const rate = m.avgCost || m.price || 0; return { material: m.name, category: m.category || '', materialGroup: groups.get(String(m.group))?.name || 'No group', unit: m.unit || 'kg', belowMinimum: (m.stock || 0) < (m.minStock || 0) ? 'Yes' : 'No', stock: r3(m.stock), minStock: r3(m.minStock), rate: r2(rate), value: r2((m.stock || 0) * rate) }; });
    },
  },

  receivables: {
    label: 'Receivables (today)', access: MONEY, dated: false,
    description: 'Customer invoices and opening balances still unpaid, with days overdue.',
    fields: { customer: F.text('Customer'), docNo: F.text('Document'), date: F.date('Date'), dueDate: F.date('Due'), bucket: F.text('Overdue bucket'), amount: F.money('Amount'), outstanding: F.money('Outstanding'), overdueDays: F.num('Days overdue', 'max') },
    async rows() {
      const rows = await require('../outstanding').receivables({});
      return rows.map((r) => ({ customer: r.partyName, docNo: r.docNo, date: day(r.date), dueDate: day(r.dueDate), bucket: r.bucket, amount: r2(r.amount), outstanding: r2(r.outstanding), overdueDays: r.overdueDays }));
    },
  },

  payables: {
    label: 'Payables (today)', access: MONEY, dated: false,
    description: 'Supplier bills, approved supplier expenses and opening balances still unpaid.',
    fields: { supplier: F.text('Supplier'), docNo: F.text('Document'), date: F.date('Date'), dueDate: F.date('Due'), bucket: F.text('Overdue bucket'), amount: F.money('Amount'), outstanding: F.money('Outstanding'), overdueDays: F.num('Days overdue', 'max') },
    async rows() {
      const rows = await require('../outstanding').payables({});
      return rows.map((r) => ({ supplier: r.partyName, docNo: r.docNo, date: day(r.date), dueDate: day(r.dueDate), bucket: r.bucket, amount: r2(r.amount), outstanding: r2(r.outstanding), overdueDays: r.overdueDays }));
    },
  },
};

/** The datasets a role may read, with their fields, for the screen. */
function describe(role) {
  return Object.entries(DATASETS).filter(([, d]) => d.access.includes(role)).map(([id, d]) => ({
    id, label: d.label, description: d.description, dated: d.dated,
    fields: Object.entries(d.fields).map(([key, f]) => ({ key, label: f.label, type: f.type, agg: f.agg || null })),
  }));
}

module.exports = { DATASETS, describe, day, month };
