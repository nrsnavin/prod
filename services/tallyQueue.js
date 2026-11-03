'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT GOES TO TALLY, ONE MESSAGE AT A TIME — AND WHAT CAME BACK
//
//  An export is cut into messages: a party ledger to create, a voucher,
//  a voucher to cancel (sent, then cancelled here), or a credit applied
//  later (an advance set against an invoice). Each says which document
//  it stamped, so when the connector reports that Tally refused one,
//  exactly that stamp comes off and the document waits in the next
//  export — nothing refused is ever marked as sent, and nothing taken
//  is sent twice.
//
//  A file download is the same messages in one envelope; there is no
//  per-voucher answer from a file, so what was in it counts as sent.
// ══════════════════════════════════════════════════════════════════

const TallyBatch = require('../models/TallyBatch');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const MODELS = {
  Invoice: () => require('../models/Invoice'),
  SupplierBill: () => require('../models/SupplierBill'),
  Expense: () => require('../models/Expense'),
  AccountNote: () => require('../models/AccountNote'),
  Payment: () => require('../models/Payment'),
  Contra: () => require('../models/Contra'),
  OpeningBalance: () => require('../models/OpeningBalance'),
};

/** <TALLYMESSAGE>s in Tally's import envelope. */
function envelope(messages, { company = '', masters = false } = {}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>',
    `<REQUESTDESC><REPORTNAME>${masters ? 'All Masters' : 'Vouchers'}</REPORTNAME>${company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : ''}</REQUESTDESC>`,
    '<REQUESTDATA>',
    ...messages,
    '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
  ].join('\n');
}

/** Take the stamp a refused message put on its document, so it goes again. */
async function unstamp(batchId, m) {
  const Model = MODELS[m.docType]?.();
  if (!Model || !m.doc) return;
  if (m.kind === 'voucher') {
    await Model.updateOne({ _id: m.doc, 'tally.batch': batchId }, { $unset: { 'tally.batch': '', 'tally.at': '' } });
  } else if (m.kind === 'cancel') {
    await Model.updateOne({ _id: m.doc, 'tally.cancelBatch': batchId }, { $unset: { 'tally.cancelBatch': '', 'tally.cancelAt': '' } });
  } else if (m.kind === 'application') {
    const list = m.docType === 'Payment' ? 'allocations' : 'applications';
    const when = m.docType === 'Payment' ? 'appliedAt' : 'at';
    await Model.updateOne(
      { _id: m.doc },
      { $unset: { [`${list}.$[a].tallyBatch`]: '' } },
      { arrayFilters: [{ [`a.${when}`]: m.at, 'a.doc': m.target, 'a.tallyBatch': batchId }] }
    );
  }
}

/**
 * The connector's answer for a batch.
 * @param results [{ key, ok, error }]
 * @returns { sent, failed, status } or null when there is no such batch
 */
async function recordResult(batchId, results) {
  const batch = await TallyBatch.findById(batchId).select('+messages delivery').lean();
  if (!batch) return null;
  const byKey = new Map((results || []).map((r) => [String(r?.key), r]));
  const errors = [];
  let sent = 0;
  for (const m of batch.messages || []) {
    const r = byKey.get(m.key);
    // A message the connector did not report on is treated as not sent.
    const ok = !!r?.ok;
    if (ok) { if (m.kind !== 'master') sent += 1; continue; }
    if (m.kind === 'master') { errors.push({ key: m.key, number: m.number, error: String(r?.error || 'not reported').slice(0, 500) }); continue; }
    errors.push({ key: m.key, number: m.number, error: String(r?.error || 'not reported').slice(0, 500) });
    await unstamp(batch._id, m);
  }
  const failed = errors.filter((e) => !String(e.key).startsWith('master:')).length;
  const status = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';
  await TallyBatch.updateOne({ _id: batch._id }, { $set: { 'delivery.status': status, 'delivery.sent': sent, 'delivery.failed': failed, 'delivery.errors': errors.slice(0, 200), 'delivery.finishedAt': new Date() } });
  return { sent, failed, status };
}

module.exports = { envelope, recordResult, unstamp, esc, MODELS };
