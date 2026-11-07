'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S ENQUIRY, DRAFTED INTO A QUOTE
//
//  "Need 20000 m 25mm black knitted, rate?" — a message, an email pasted
//  in, or a photo of their sample with its label.
//
//  draft({ text, pages, customer }) →
//    read       what was asked: items (description, width, colour,
//               metres, the rate they hope for), needed by
//    customer   the customer on file it matches, or candidates
//    lines[]    per item: the elastic it matches (numbers never
//               conflict: 20mm is never 25mm), its cost a metre from
//               the recipe at today's prices, a margin suggested from
//               past quotes and why, ready for the quote form
//    coverNote  a short note to send with it, from these figures only
//
//  The model reads; it never prices. Every rupee here comes from the
//  cost sheet and the quotes already decided, and a person sets the
//  price before anything is sent.
// ══════════════════════════════════════════════════════════════════

const Elastic = require('../models/Elastic');
const Customer = require('../models/Customer');
const Quote = require('../models/Quote');
const { rank } = require('../utils/fuzzyMatch');
const { readJson, parseJson, num, str } = require('../utils/docRead');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { buildCostSheet } = require('./elasticCostSheet');

const DEFAULT_MARGIN = 15;
const PROMPT = [
  'This is an enquiry to a narrow-fabric (elastic tape) factory in India: a WhatsApp message, an email, or a photo of a',
  'sample and its label. Read what they want priced. Return ONLY JSON:',
  '{"problem":null,"customerName":"Sunrise Garments","items":[{"description":"25mm knitted elastic black","widthMm":25,',
  ' "colour":"Black","quantityMetres":20000,"targetRate":4.2}],"neededBy":"2026-12-01","notes":"soft handfeel"}',
  '- items: one per product. widthMm: the width in mm (1 inch = 25mm). quantityMetres: metres asked for (a roll/bundle',
  '  count only if metres are not given: leave null). targetRate: a rate per metre they mention, else null.',
  '- neededBy: YYYY-MM-DD if a date is given, else "". Never invent a figure; leave it null or "".',
  '- Not an enquiry for elastic: {"problem":"not_an_enquiry"}.',
].join('\n');

function normaliseRead(raw) {
  if (!raw) return { problem: 'unreadable' };
  if (raw.problem === 'not_an_enquiry' || raw.problem === 'unreadable') return { problem: raw.problem };
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 10).map((it) => {
    const qty = num(it?.quantityMetres); const target = num(it?.targetRate); const w = num(it?.widthMm);
    return {
      description: str(it?.description, 160),
      widthMm: w != null && w > 0 && w < 500 ? w : null,
      colour: str(it?.colour, 40),
      quantityMetres: qty != null && qty > 0 ? qty : null,
      targetRate: target != null && target > 0 ? target : null,
    };
  }).filter((it) => it.description || it.widthMm);
  const neededBy = str(raw.neededBy, 10);
  return {
    problem: items.length ? null : 'not_an_enquiry',
    customerName: str(raw.customerName, 120),
    items,
    neededBy: /^\d{4}-\d{2}-\d{2}$/.test(neededBy) ? neededBy : '',
    notes: str(raw.notes, 300),
  };
}

/** The enquiry read, from text or from photos. */
async function readEnquiry({ text, pages }) {
  if (pages && pages.length) {
    const r = await readJson({ pages, prompt: text ? `${PROMPT}\n\nThe message that came with it:\n${String(text).slice(0, 4000)}` : PROMPT, maxTokens: 800, maxPages: 3 });
    return { ...normaliseRead(r.data), model: r.model, usage: r.usage, latencyMs: r.latencyMs };
  }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }
  const startedAt = Date.now();
  const msg = await claude.messages.create({ model: TEXT_MODEL, max_tokens: 800, messages: [{ role: 'user', content: `${PROMPT}\n\nThe enquiry:\n${String(text).slice(0, 6000)}` }] });
  const reply = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...normaliseRead(parseJson(reply)), model: TEXT_MODEL, usage: msg.usage, latencyMs: Date.now() - startedAt };
}

const r1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const lineMargin = (l) => (Number(l.totalCost) > 0 && Number(l.rateBeforeTax) > 0 ? (l.rateBeforeTax / l.totalCost - 1) * 100 : null);

/** A margin for this elastic and customer, from the quotes already decided, with why. */
async function suggestMargin(elasticId, customerId) {
  const since = new Date(Date.now() - 365 * 86_400_000);
  const decided = await Quote.find({ status: { $in: ['accepted', 'declined'] }, date: { $gte: since } })
    .select('quoteNo customer status date lines.elastic lines.totalCost lines.rateBeforeTax').sort({ date: -1 }).limit(500).lean();
  const rows = [];
  for (const q of decided) for (const l of q.lines || []) {
    const m = lineMargin(l);
    if (m != null) rows.push({ quoteNo: q.quoteNo, won: q.status === 'accepted', mine: customerId && String(q.customer) === String(customerId), same: elasticId && String(l.elastic) === String(elasticId), margin: m });
  }
  const reasons = [];
  const pick = (list, why) => { const m = median(list.map((x) => x.margin)); if (m == null) return null; reasons.push(why(m, list)); return m; };
  let margin = null;
  const theirs = rows.filter((r) => r.won && r.mine && r.same);
  if (theirs.length) margin = pick(theirs.slice(0, 1), (m, l) => `They accepted ${r1(m)}% on ${l[0].quoteNo} for this elastic.`);
  if (margin == null) { const won = rows.filter((r) => r.won && r.same); if (won.length) margin = pick(won, (m, l) => `${r1(m)}% is the middle of ${l.length} accepted quote${l.length === 1 ? '' : 's'} for this elastic.`); }
  if (margin == null) { const won = rows.filter((r) => r.won); if (won.length >= 3) margin = pick(won, (m, l) => `${r1(m)}% is the middle of ${l.length} quotes accepted this year.`); }
  if (margin == null) { margin = DEFAULT_MARGIN; reasons.push(`No decided quotes to learn from yet — ${DEFAULT_MARGIN}% to start.`); }
  const lost = rows.filter((r) => !r.won && (r.same || r.mine) && r.margin <= margin + 0.5);
  if (lost.length) reasons.push(`Declined at ${r1(Math.min(...lost.map((l) => l.margin)))}% before (${lost[0].quoteNo}) — they may push back.`);
  return { margin: r1(Math.max(0, margin)), reasons };
}

function coverNote({ customerName, lines, neededBy }) {
  const priced = lines.filter((l) => l.rate);
  const list = priced.map((l) => `• ${l.productName}${l.quantityMetres ? ` — ${Number(l.quantityMetres).toLocaleString('en-IN')} m` : ''} at ₹${l.rate.toFixed(2)}/m + GST`).join('\n');
  return [
    `Dear ${customerName || 'Sir/Madam'},`,
    '',
    'Thank you for your enquiry. Our rates:',
    list || '• (rates to follow)',
    '',
    neededBy ? `We will confirm delivery for ${new Date(`${neededBy}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} once the order is placed.` : 'Delivery will be confirmed with the order.',
    'Rates are valid for 30 days. We can send a sample on request.',
  ].join('\n');
}

async function draft({ text, pages, customer }) {
  const read = await readEnquiry({ text, pages });
  if (read.problem) return { read, customer: null, lines: [], coverNote: '' };

  // The customer: the one picked, else the name read matched to the master.
  let cust = null; let custCandidates = [];
  if (customer) cust = await Customer.findById(customer).select('name').lean();
  if (!cust && read.customerName) {
    const all = await Customer.find({}).select('name').limit(5000).lean();
    const r = rank(read.customerName, all.map((c) => ({ id: String(c._id), label: c.name })), { limit: 3, floor: 0.5 });
    custCandidates = r.candidates.map((c) => ({ _id: c.id, name: c.label, score: Math.round(c.score * 100) / 100 }));
    if (r.confident) cust = { _id: r.best.id, name: r.best.label };
  }

  const elastics = await Elastic.find({ archived: { $ne: true } }).select('name').limit(5000).lean();
  const choices = elastics.map((e) => ({ id: String(e._id), label: e.name }));
  const lines = [];
  for (const it of read.items) {
    const query = [it.widthMm ? `${it.widthMm}mm` : '', it.description, it.colour].filter(Boolean).join(' ');
    const r = rank(query, choices, { limit: 3 });
    const matched = r.confident ? r.best : null;
    const line = {
      asked: it, productName: matched ? matched.label : it.description || query, productSpec: [it.widthMm ? `${it.widthMm} mm` : '', it.colour].filter(Boolean).join(' · '),
      elastic: matched ? matched.id : null, candidates: r.candidates.map((c) => ({ _id: c.id, name: c.label })),
      quantityMetres: it.quantityMetres || 0, materials: [], conversionCost: 0, marginPercent: DEFAULT_MARGIN, cost: null, rate: null, reasons: [],
    };
    if (matched) {
      const sheet = await buildCostSheet(matched.id);
      if (sheet) {
        line.materials = sheet.lines.filter((l) => l.grams > 0 && l.price != null).map((l) => ({ label: `${l.role} — ${l.material.name}`, weightGrams: l.grams, ratePerKg: l.price }));
        line.conversionCost = sheet.now.conversionCost;
        line.cost = Math.round(sheet.now.totalCost * 100) / 100;
        if (sheet.missing) line.reasons.push(`${sheet.missing} recipe material${sheet.missing === 1 ? ' has' : 's have'} no price — the cost is short.`);
      }
      const s = await suggestMargin(matched.id, cust?._id);
      line.marginPercent = s.margin;
      line.reasons.push(...s.reasons);
    } else {
      line.reasons.push(line.candidates.length ? 'Not sure which elastic this is — pick it, or cost it by hand.' : 'No elastic on file like this — cost it by hand, or create it first.');
    }
    if (line.cost) {
      line.rate = Math.round(line.cost * (1 + line.marginPercent / 100) * 100) / 100;
      if (it.targetRate) {
        const at = r1((it.targetRate / line.cost - 1) * 100);
        line.reasons.push(at < 0 ? `Their ₹${it.targetRate}/m is below cost (₹${line.cost}).` : `Their ₹${it.targetRate}/m is a ${at}% margin.`);
      }
    }
    lines.push(line);
  }
  const name = cust?.name || read.customerName;
  return { read, customer: cust ? { _id: String(cust._id), name: cust.name } : null, customerCandidates: custCandidates, customerName: name, lines, coverNote: coverNote({ customerName: name, lines, neededBy: read.neededBy }) };
}

module.exports = { draft, readEnquiry, normaliseRead, suggestMargin, coverNote, PROMPT };
