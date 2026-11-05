'use strict';
// ═════════════════════════════════════════════════════════════════
//  A SUPPLIER'S STATEMENT OF OUR ACCOUNT, READ
//
//  Suppliers send their ledger of our account (a PDF, a photo, an Excel
//  sheet) to agree balances. This reads it into its entries as THEY
//  book them: their invoices (debits to us), our payments they received
//  and the TDS we deducted (credits), their credit and debit notes, the
//  opening and closing balances. It only READS: which of our bills and
//  payments each entry is, is services/supplierRecon.js's work.
//
//  readStatement({ pages?, sheet? }) -> {
//    problem, partyName, partyGstin, from, to, opening, closing,
//    entries: [{ date, docNo, kind, debit, credit, narration }],
//    confidence, model, usage, latencyMs
//  }
//  kind: invoice | payment | tds | credit_note | debit_note | opening | other
// ═════════════════════════════════════════════════════════════════
const { anthropic, VISION_MODEL, TEXT_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const SHEETS = /\.(xlsx|csv)$/i;
const KINDS = new Set(['invoice', 'payment', 'tds', 'credit_note', 'debit_note', 'opening', 'other']);
const MAX_ROWS = 600;

const PROMPT = [
  'This is a SUPPLIER\'S statement of account (their ledger of our account) sent to an elastic weaving',
  'factory in India, us, so the two sides can agree the balance. Read every entry AS THE SUPPLIER BOOKED IT.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"problem":null,"partyName":"Sri Yarn Traders","partyGstin":"33AAAPS0001F1Z5","from":"2026-04-01","to":"2026-09-30",',
  ' "opening":12000,"closing":48530,',
  ' "entries":[{"date":"2026-07-04","docNo":"SY/118","kind":"invoice","debit":19530,"credit":0,"narration":"Sales"},',
  '            {"date":"2026-07-20","docNo":"","kind":"payment","debit":0,"credit":18000,"narration":"NEFT received"}],',
  ' "confidence":0.85}',
  '',
  'Rules:',
  '- debit: what the supplier booked as our owing more (their invoice, their debit note); credit: our owing',
  '  less (a payment from us, TDS we deducted, their credit note). Numbers without commas.',
  '- kind: invoice, payment, tds, credit_note, debit_note, opening (the brought-forward line) or other.',
  '- docNo: their invoice or note number exactly as printed; for a payment, any cheque or UTR, else "".',
  '- date YYYY-MM-DD. opening and closing: the balances as printed, positive when we owe them, else null.',
  '- Do not add entries that are not printed. Running-balance columns are not entries.',
  '- problem: "not_a_statement" when this is not a statement of account; "unreadable" when it cannot be read.',
].join('\n');

function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch (_) { return null; }
}
const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? n : null; };
const asDate = (v) => {
  const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function normalise(raw, meta) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const entries = (Array.isArray(r.entries) ? r.entries : []).map((e) => {
    if (!e || typeof e !== 'object') return null;
    const debit = Math.max(0, num(e.debit) || 0);
    const credit = Math.max(0, num(e.credit) || 0);
    if (!debit && !credit) return null;
    return { date: asDate(e.date), docNo: str(e.docNo).slice(0, 40), kind: KINDS.has(e.kind) ? e.kind : 'other', debit, credit, narration: str(e.narration).slice(0, 120) };
  }).filter(Boolean).slice(0, MAX_ROWS);
  const gstin = str(r.partyGstin).toUpperCase();
  return {
    problem: r.problem === 'not_a_statement' || r.problem === 'unreadable' ? r.problem : (entries.length ? null : 'unreadable'),
    partyName: str(r.partyName).slice(0, 120),
    partyGstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : '',
    from: asDate(r.from), to: asDate(r.to),
    opening: num(r.opening), closing: num(r.closing),
    entries,
    confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)),
    ...meta,
  };
}

/** An Excel sheet or CSV as plain rows of text, for the text model. */
async function sheetText(file) {
  if (/\.csv$/i.test(file.originalname || '') || /csv/.test(file.mimetype || '')) return file.buffer.toString('utf8').split(/\r?\n/).slice(0, MAX_ROWS + 20).join('\n');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  const rows = [];
  ws?.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length > MAX_ROWS + 20) return;
    const cells = (Array.isArray(row.values) ? row.values.slice(1) : []).map((v) => {
      if (v == null) return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : '');
      return String(v);
    });
    rows.push(cells.join(' | '));
  });
  return rows.join('\n');
}

/**
 * @param {{ files: Array<{buffer, mimetype, originalname}> }} p
 */
async function readStatement({ files = [] } = {}) {
  const list = (files || []).filter((f) => f && f.buffer && f.buffer.length);
  if (!list.length) { const e = new Error('Attach their statement.'); e.code = 'NO_PAGES'; throw e; }
  const sheet = list.find((f) => SHEETS.test(f.originalname || '') || /spreadsheet|csv|excel/.test(f.mimetype || ''));
  const pages = sheet ? [] : list;
  const bad = pages.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) { const e = new Error(`Cannot read a ${bad.mimetype} file. Send a PDF, a photo, an Excel sheet or a CSV.`); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  if (pages.length > 6) { const e = new Error('At most 6 pages.'); e.code = 'TOO_MANY_PAGES'; throw e; }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }

  const model = sheet ? TEXT_MODEL : VISION_MODEL;
  const content = sheet
    ? [{ type: 'text', text: `The statement, as rows of its sheet:\n"""\n${await sheetText(sheet)}\n"""\n\n${PROMPT}` }]
    : [...pages.map((p) => {
      const data = p.buffer.toString('base64');
      return p.mimetype === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } : { type: 'image', source: { type: 'base64', media_type: p.mimetype, data } };
    }), { type: 'text', text: PROMPT }];
  const startedAt = Date.now();
  const message = await claude.messages.create({ model, max_tokens: 8192, messages: [{ role: 'user', content }] });
  const reply = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(parseJsonReply(reply), { model, usage: message.usage, latencyMs: Date.now() - startedAt });
}

module.exports = { readStatement, normalise, sheetText, PROMPT };
