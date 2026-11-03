'use strict';
// ═════════════════════════════════════════════════════════════════
//  Lorry receipt (LR / consignment note) OCR  (Claude vision)
//
//  A transporter's receipt for the cartons of a delivery challan:
//  their LR number and date, the vehicle, who they are (name, GSTIN),
//  how many packages and how heavy, and the freight. Copied as printed
//  or handwritten, never computed. Which challan it belongs to and
//  which supplier on file the transporter is are worked out against the
//  database, not by the model.
//
//  readLr(pages) -> { problem, lrNumber, lrDate, vehicleNo, transporterName,
//    transporterGstin, consignee, destination, packages, weightKg, freight,
//    paidBy: 'paid'|'to_pay'|null, confidence, model, usage, latencyMs }
// ═════════════════════════════════════════════════════════════════
const { anthropic, VISION_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const PROMPT = [
  'This is a lorry receipt (LR, consignment note, GC note, booking receipt) from a road transporter in India,',
  'for cartons of elastic sent by a weaving factory in Tiruppur to its customer.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"problem":null,"lrNumber":"TPR/4471","lrDate":"2026-11-02","vehicleNo":"TN38AB1234",',
  ' "transporterName":"VRL Logistics","transporterGstin":null,"consignee":"Sunrise Garments","destination":"Erode",',
  ' "packages":14,"weightKg":320,"freight":4200,"paidBy":"paid","confidence":0.8}',
  '',
  'Rules:',
  '- lrNumber: the LR / GC / consignment number as printed or written. lrDate as YYYY-MM-DD (day first:',
  '  02/11/26 is 2 November 2026). Null when not there; never guess.',
  '- vehicleNo: the lorry number without spaces, upper case (TN38AB1234), else null.',
  '- transporterName: the transport company issuing the receipt. transporterGstin: its 15-character GSTIN if printed.',
  '- consignee: who the goods go to. destination: the delivery town.',
  '- packages: number of cartons/bundles/articles. weightKg: the charged or actual weight in kg.',
  '- freight: the total freight amount to pay, including hamali/loading and other charges if a total is',
  '  printed; else the freight figure. Copied, not added up. paidBy: "paid" if marked paid/prepaid, "to_pay"',
  '  if to-pay/topay, else null.',
  '- confidence: 0 to 1; lower it for handwriting you are unsure of.',
  '- Not a lorry receipt: {"problem":"not_an_lr"}. One that cannot be read: {"problem":"unreadable"}.',
].join('\n');

function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch { return null; }
}

const str = (v, n = 80) => (v == null ? '' : String(v).trim().slice(0, n));
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const asDate = (v) => {
  const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function normalise(raw, meta = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const problem = ['not_an_lr', 'unreadable'].includes(r.problem) ? r.problem : null;
  const gstin = str(r.transporterGstin, 15).toUpperCase();
  const out = {
    problem,
    lrNumber: str(r.lrNumber, 40),
    lrDate: asDate(r.lrDate),
    vehicleNo: str(r.vehicleNo, 15).toUpperCase().replace(/[\s-]/g, ''),
    transporterName: str(r.transporterName, 120),
    transporterGstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : '',
    consignee: str(r.consignee, 120),
    destination: str(r.destination, 60),
    packages: num(r.packages),
    weightKg: num(r.weightKg),
    freight: num(r.freight),
    paidBy: r.paidBy === 'paid' || r.paidBy === 'to_pay' ? r.paidBy : null,
    confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)),
    ...meta,
  };
  if (!out.problem && !out.lrNumber && !out.freight && !out.vehicleNo) out.problem = 'unreadable';
  return out;
}

async function readLr(pages) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  if (!list.length) { const e = new Error('No photo to read.'); e.code = 'NO_PAGES'; throw e; }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) { const e = new Error(`Cannot read a ${bad.mimetype} file. Send a photo (JPEG or PNG) or a PDF.`); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }
  const startedAt = Date.now();
  const content = list.slice(0, 2).map((p) => {
    const data = p.buffer.toString('base64');
    return p.mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: p.mimetype, data } };
  });
  const message = await claude.messages.create({ model: VISION_MODEL, max_tokens: 800, messages: [{ role: 'user', content: [...content, { type: 'text', text: PROMPT }] }] });
  const reply = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(parseJson(reply), { model: VISION_MODEL, usage: message.usage, latencyMs: Date.now() - startedAt });
}

module.exports = { readLr, normalise, PROMPT, SUPPORTED };
