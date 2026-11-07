'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SUPPLIER'S CHALLAN OR INVOICE, AND CONE / BAG LABELS, READ INTO
//  GOODS RECEIVED
//
//  readInward(pages) → { problem, supplierName, dcNo, invoiceNo, poNumber,
//    date, lines: [{ description, quantity, unit, rate, lotNo, shade,
//    packages }], model, usage, latencyMs }
//  Photos may mix the challan with the labels of what came; a label's
//  lot, count, shade and net weight become a line of their own.
//  Matching to the PO is services-side (api/supplier.js /inward/read).
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const PROMPT = [
  'These photos are from goods received at an elastic factory in Tamil Nadu: a supplier\'s delivery challan or tax invoice,',
  'and/or the labels on the cones or bags that came (yarn, rubber/spandex, covering). Read what was delivered. Return ONLY JSON:',
  '{"problem":null,"supplierName":"Sri Yarn Traders","dcNo":"SY/DC/412","invoiceNo":"","poNumber":"PO-118","date":"2026-11-06",',
  ' "lines":[{"description":"40s PC Black","quantity":250.5,"unit":"kg","rate":220,"lotNo":"L2611","shade":"Black 1102","packages":10}]}',
  '- problem: "not_a_receipt" when these are not a challan, invoice or goods labels; "unreadable" when they cannot be read; else null.',
  '- lines: one per item delivered. quantity is the NET quantity (net weight in kg for yarn and rubber); unit as written (kg, m, pcs).',
  '- From a label: description = count/denier, fibre and shade; quantity = net weight; lotNo = the lot or batch number; shade = the shade or colour code.',
  '  When several labels are the same lot, give ONE line with the weights added and packages = how many labels.',
  '- rate: per unit when the invoice gives it, else null. poNumber: our PO number when the document quotes it, else "".',
  '- Never guess a number; leave it null when it is not printed.',
].join('\n');

function normalise(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_a_receipt' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  return {
    problem: null,
    supplierName: str(raw.supplierName, 100),
    dcNo: str(raw.dcNo, 40),
    invoiceNo: str(raw.invoiceNo, 40),
    poNumber: str(raw.poNumber, 40),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? raw.date : null,
    lines: (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 40).map((l) => ({
      description: str(l?.description, 100),
      quantity: num(l?.quantity),
      unit: str(l?.unit, 10).toLowerCase(),
      rate: num(l?.rate),
      lotNo: str(l?.lotNo, 40),
      shade: str(l?.shade, 40),
      packages: num(l?.packages),
    })).filter((l) => l.description || l.quantity != null),
    ...meta,
  };
}

async function readInward(pages) {
  const r = await readJson({ pages, prompt: PROMPT, maxTokens: 2000, maxPages: 6 });
  return normalise(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

module.exports = { readInward, normalise, PROMPT };
