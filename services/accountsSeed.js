'use strict';
// First-run defaults for the accounts module: the cash box and the
// expense heads a weaving factory has. Idempotent — called from the
// routes that list them, so a fresh database starts usable.

const BankAccount = require('../models/BankAccount');
const ExpenseCategory = require('../models/ExpenseCategory');

const CATEGORIES = [
  { name: 'Transport & freight', ledger: 'Freight Outward', itcEligible: true, tdsSection: '194C', approvalAbove: 5000 },
  { name: 'Job work', ledger: 'Job Work Charges', itcEligible: true, tdsSection: '194C', approvalAbove: 0 },
  { name: 'Electricity', ledger: 'Power & Fuel', itcEligible: false, approvalAbove: 0 },
  { name: 'Rent', ledger: 'Rent', itcEligible: true, tdsSection: '194I', approvalAbove: 0 },
  { name: 'Repairs & maintenance', ledger: 'Repairs & Maintenance', itcEligible: true, approvalAbove: 5000 },
  { name: 'Spares & consumables', ledger: 'Consumables', itcEligible: true, approvalAbove: 5000 },
  { name: 'Packing material', ledger: 'Packing Material', itcEligible: true, approvalAbove: 5000 },
  { name: 'Professional fees', ledger: 'Professional Charges', itcEligible: true, tdsSection: '194J', approvalAbove: 0 },
  { name: 'Office & stationery', ledger: 'Office Expenses', itcEligible: true, approvalAbove: 2000 },
  { name: 'Staff welfare', ledger: 'Staff Welfare', itcEligible: false, approvalAbove: 2000 },
  { name: 'Bank charges', ledger: 'Bank Charges', itcEligible: true, approvalAbove: 100000 },
  { name: 'Miscellaneous', ledger: 'Miscellaneous Expenses', itcEligible: false, approvalAbove: 1000 },
];

async function ensureSeed() {
  if ((await ExpenseCategory.estimatedDocumentCount()) === 0) {
    await ExpenseCategory.insertMany(CATEGORIES, { ordered: false }).catch(() => {});
  }
  if ((await BankAccount.estimatedDocumentCount()) === 0) {
    await BankAccount.create({ name: 'Cash box', kind: 'cash', isDefault: true, float: 10000 });
  }
}

module.exports = { ensureSeed, CATEGORIES };
