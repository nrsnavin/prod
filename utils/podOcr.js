'use strict';
// ══════════════════════════════════════════════════════════════════
//  PROOF OF DELIVERY: the signed copy of our challan, or the
//  transporter's POD, read into when it was delivered, who took it,
//  and anything they wrote ("2 boxes short", "1 carton wet").
//
//  readPod(pages) → { problem, dcNumber, deliveredOn, receivedBy,
//    stamped, remark, issue: 'short'|'damaged'|'wrong'|null,
//    shortPackages, model, usage, latencyMs }
//  Which challan it belongs to is the route's call, not the model's.
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const PROMPT = [
  'This is a proof of delivery from India: the customer\'s signed and stamped copy of a delivery challan (DC),',
  'or a road transporter\'s POD / delivery receipt, for cartons of elastic tape. Return ONLY JSON:',
  '{"problem":null,"dcNumber":"DC/26-27/0142","deliveredOn":"2026-11-05","receivedBy":"Ramesh (stores)","stamped":true,',
  ' "remark":"2 boxes short","issue":"short","shortPackages":2}',
  '- dcNumber: our challan number as printed on it, else "".',
  '- deliveredOn: the date written or stamped as received, YYYY-MM-DD (day first: 05/11/26 is 5 November 2026). "" when there is none — never the printed challan date.',
  '- receivedBy: the receiver\'s name or designation as written, "" if only a signature. stamped: true when a company seal is on it.',
  '- remark: anything written by the receiver about the goods, copied in English. issue: "short" for fewer boxes/metres,',
  '  "damaged" for wet/torn/damaged, "wrong" for a wrong item/colour/size, else null. shortPackages: how many short, else null.',
  '- Not a challan or POD: {"problem":"not_a_pod"}. Unreadable: {"problem":"unreadable"}. Never guess.',
].join('\n');

const ISSUES = ['short', 'damaged', 'wrong'];

function normalisePod(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_a_pod' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  const d = str(raw.deliveredOn, 10);
  const remark = str(raw.remark, 300);
  let issue = ISSUES.includes(raw.issue) ? raw.issue : null;
  // The model sometimes leaves issue empty for a plain "2 box short".
  if (!issue && /\b(short|less|missing)\b/i.test(remark)) issue = 'short';
  if (!issue && /\b(damag|wet|torn|broken)/i.test(remark)) issue = 'damaged';
  const shortPackages = num(raw.shortPackages);
  return {
    problem: null,
    dcNumber: str(raw.dcNumber, 40),
    deliveredOn: /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : '',
    receivedBy: str(raw.receivedBy, 80),
    stamped: raw.stamped === true,
    remark,
    issue,
    shortPackages: shortPackages != null && shortPackages > 0 ? shortPackages : null,
    ...meta,
  };
}

async function readPod(pages) {
  const r = await readJson({ pages, prompt: PROMPT, maxTokens: 400, maxPages: 2 });
  return normalisePod(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

module.exports = { readPod, normalisePod, PROMPT, ISSUES };
