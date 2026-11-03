'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S COMPLAINT, READ — AND A REPLY, DRAFTED
//
//  intake({ customer, text, images })
//    The office pastes what the customer sent (WhatsApp, email, a call
//    written down; English, Tamil or both) and any photos. Back come:
//      • the category, from the fixed list
//      • the complaint in plain English, in the customer's sense
//      • which of this customer's jobs it most likely is, with why —
//        chosen from candidates the database gives, never invented
//      • the elastic, ONLY when the customer named one we can find on
//        those jobs (the trace narrows to it; a guess would narrow it to
//        the wrong product, so "not named" stays empty)
//    With no model configured, the same answer from keywords and dates.
//
//  draftReply(complaintId)
//    A short reply to the customer from the complaint, its status and
//    resolution, and what the trace found. It never promises a credit,
//    a replacement or a date that is not written in the resolution.
//
//  Nothing is saved here. The form opens filled in; what the person
//  files settles the AI ledger row.
// ══════════════════════════════════════════════════════════════════

const Complaint = require('../models/Complaints');
const { CATEGORIES } = require('../models/Complaints');
const JobOrder = require('../models/JobOrder');
const Customer = require('../models/Customer');
const { anthropic, TEXT_MODEL, VISION_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const DAY = 86_400_000;
const MAX_CANDIDATES = 25;

/** Words a customer uses, by category. Order matters: the first hit wins. */
const KEYWORDS = [
  ['shade', /\b(shade|colou?r|dye|dyed|tone|band|patch|stain|faded?|bleed)/i],
  ['width', /\b(width|wide|narrow|mm\b|size)/i],
  ['strength', /\b(strength|stretch|elongation|recovery|break|broke|torn|tear|snap|loose|rubber|power|weak)/i],
  ['quantity', /\b(short|less (?:qty|quantity|meters?|metres?)|missing|quantity|count|meters? less)/i],
  ['packing', /\b(pack|packing|packed|carton|box|roll(?:ed)? (?:loose|damaged)|label)/i],
  ['delivery', /\b(late|delay|delayed|not (?:yet )?(?:received|delivered)|deliver(?:y|ed)? (?:date|late))/i],
  ['finish', /\b(finish|edge|curl|curling|rough|hairy|fluff|crease|wrinkle|smell)/i],
];

function keywordCategory(text) {
  for (const [cat, re] of KEYWORDS) if (re.test(text)) return cat;
  return 'other';
}

function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch { return null; }
}

const dmy = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** The customer's recent jobs, newest first, with the elastics on each. */
async function candidates(customer, { days = 240 } = {}) {
  const jobs = await JobOrder.find({ customer, status: { $ne: 'cancelled' }, date: { $gte: new Date(Date.now() - days * DAY) } })
    .select('jobOrderNo date status elastics.elastic')
    .populate('elastics.elastic', 'name')
    .sort({ date: -1 }).limit(MAX_CANDIDATES).lean();
  return jobs.map((j) => ({
    _id: String(j._id), jobOrderNo: j.jobOrderNo, date: j.date, status: j.status,
    elastics: (j.elastics || []).map((e) => e.elastic).filter(Boolean).map((e) => ({ _id: String(e._id), name: e.name })),
  }));
}

/** An elastic named in the text, looked for on the candidate jobs only. */
function namedElastic(text, jobs) {
  const t = String(text || '').toLowerCase();
  let best = null;
  for (const j of jobs) for (const e of j.elastics) {
    const name = String(e.name || '').toLowerCase().trim();
    if (name.length >= 3 && t.includes(name) && (!best || name.length > best.name.length)) best = { ...e, name: e.name };
  }
  return best;
}

/** Without a model: keywords for the category, the name for the elastic, the newest delivered jobs first. */
function fallback(text, jobs) {
  const elastic = namedElastic(text, jobs);
  const ranked = [...jobs].sort((a, b) => {
    const has = (j) => (elastic && j.elastics.some((e) => e._id === elastic._id) ? 1 : 0);
    const done = (j) => (['completed', 'packing'].includes(j.status) ? 1 : 0);
    return has(b) - has(a) || done(b) - done(a) || new Date(b.date) - new Date(a.date);
  });
  return {
    category: keywordCategory(text),
    reason: String(text || '').trim().slice(0, 500),
    jobs: ranked.slice(0, 3).map((j) => ({ ...j, why: elastic && j.elastics.some((e) => e._id === elastic._id) ? `carries ${elastic.name}` : `job of ${dmy(j.date)}, ${j.status}` })),
    elastic,
    confidence: 0.3,
  };
}

const INTAKE_PROMPT = [
  'You help the office of an elastic (narrow-fabric) weaving factory in Tiruppur file a customer complaint.',
  'You get what the customer sent (it may be English, Tamil, or Tanglish, from WhatsApp or a phone call),',
  'perhaps photos, and a numbered list of this customer\'s recent jobs with the elastics on each.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"category":"shade","reason":"Shade band across the 25 mm black rolls from the last delivery",',
  ' "jobs":[{"n":0,"why":"only job with 25mm black, delivered 12 Oct"}],"elastic":3,"confidence":0.8}',
  '',
  'Rules:',
  `- category: exactly one of ${CATEGORIES.join(', ')}.`,
  '- reason: the complaint in one or two plain English sentences, keeping the customer\'s specifics',
  '  (sizes, colours, quantities, dates). Translate Tamil. Do not add anything they did not say.',
  '- jobs: up to 3 job numbers n from the list, most likely first, each with a short why that cites',
  '  what in the message matches (the elastic, the date, the delivery). Never a number not in the list.',
  '  An empty list when nothing in the message points to a job.',
  '- elastic: the number e of an elastic from the list ONLY if the customer clearly named that product',
  '  (its name, width and colour). Otherwise null. A wrong guess sends the investigation to the wrong',
  '  product; null is always safe.',
  '- confidence: 0 to 1.',
].join('\n');

/**
 * @param {{ customer: string, text: string, images?: Array<{buffer: Buffer, mimetype: string}> }} p
 */
async function intake({ customer, text, images = [] }) {
  const cust = await Customer.findById(customer).select('name').lean();
  if (!cust) { const e = new Error('Customer not found'); e.status = 404; throw e; }
  const jobs = await candidates(customer);
  const elastics = [];
  for (const j of jobs) for (const e of j.elastics) if (!elastics.some((x) => x._id === e._id)) elastics.push(e);

  const claude = anthropic();
  if (!claude || (!String(text || '').trim() && !images.length)) {
    return { ...fallback(text, jobs), aiGenerated: false, aiSuggestion: null, candidates: jobs.length };
  }

  const listing = jobs.map((j, i) => `${i}. Job ${j.jobOrderNo ?? '?'} · ${dmy(j.date)} · ${j.status} · elastics: ${j.elastics.map((e) => `[e${elastics.findIndex((x) => x._id === e._id)}] ${e.name}`).join('; ') || 'none'}`).join('\n');
  const elasticList = elastics.map((e, i) => `${i}. ${e.name}`).join('\n');
  const model = images.length ? VISION_MODEL : TEXT_MODEL;
  const startedAt = Date.now();
  try {
    const content = [
      ...images.slice(0, 3).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimetype, data: img.buffer.toString('base64') } })),
      { type: 'text', text: `Customer: ${cust.name}\n\nWhat they sent:\n"""\n${String(text || '(photos only)').slice(0, 4000)}\n"""\n\nTheir recent jobs:\n${listing || '(none)'}\n\nElastics on those jobs:\n${elasticList || '(none)'}\n\n${INTAKE_PROMPT}` },
    ];
    const msg = await claude.messages.create({ model, max_tokens: 800, messages: [{ role: 'user', content }] });
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw) throw new Error('model returned unparseable JSON');
    const category = CATEGORIES.includes(raw.category) ? raw.category : keywordCategory(text);
    const picked = [];
    for (const x of Array.isArray(raw.jobs) ? raw.jobs : []) {
      const n = Number(x?.n);
      if (Number.isInteger(n) && n >= 0 && n < jobs.length && !picked.some((p) => p._id === jobs[n]._id)) picked.push({ ...jobs[n], why: String(x.why || '').slice(0, 160) });
      if (picked.length === 3) break;
    }
    const ei = raw.elastic == null ? null : Number(raw.elastic);
    const elastic = Number.isInteger(ei) && ei >= 0 && ei < elastics.length ? elastics[ei] : null;
    const reason = String(raw.reason || text || '').trim().slice(0, 500);
    const out = { category, reason, jobs: picked, elastic, confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.5)) };
    const aiSuggestion = await ledger.record({
      surface: 'complaint-intake', model, promptVersion: promptVersion('complaint-intake'), refType: 'customer', refId: cust._id,
      proposed: { category, reason, job: picked[0]?._id || null, elastic: elastic?._id || null },
      latencyMs: Date.now() - startedAt, usage: msg.usage,
    });
    return { ...out, aiGenerated: true, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null, candidates: jobs.length };
  } catch (err) {
    await ledger.record({ surface: 'complaint-intake', model, promptVersion: promptVersion('complaint-intake'), latencyMs: Date.now() - startedAt, error: err?.message || String(err) });
    return { ...fallback(text, jobs), aiGenerated: false, aiSuggestion: null, candidates: jobs.length };
  }
}

const REPLY_PROMPT = [
  'Write a short reply from an elastic manufacturer to a customer about their complaint, to send on WhatsApp.',
  'Plain text, 60 to 120 words, polite and direct, no subject line, no placeholders like [Name].',
  'Say what was received and when, what we are doing or found (from the facts given only), and the next step.',
  'Never promise a credit note, a replacement, a discount or a date unless the resolution given says so.',
  'Never mention other customers or other orders. Never quote internal lot numbers.',
  'Sign off with the company name given.',
].join('\n');

function templateReply(c, company) {
  const when = dmy(c.date);
  const job = c.job?.jobOrderNo ? ` (job ${c.job.jobOrderNo})` : '';
  const what = c.elastic?.name ? ` on ${c.elastic.name}` : '';
  const state = c.status === 'Resolved' || c.status === 'Closed'
    ? (c.resolution ? `What we found and did: ${c.resolution}` : 'We have looked into it and closed it on our side.')
    : c.status === 'Rejected'
      ? (c.resolution ? `We checked this carefully: ${c.resolution}` : 'We checked this carefully and could not find a fault on our side.')
      : 'Our quality team is checking the production records and samples from that batch now, and we will update you shortly.';
  return `Dear ${c.customer?.name || 'Sir/Madam'},\n\nThank you for letting us know about the ${c.category === 'other' ? 'issue' : `${c.category} issue`}${what} you reported on ${when}${job}. ${state}\n\nRegards,\n${company}`;
}

/** A reply to the customer about one complaint. */
async function draftReply(complaintId, { company = 'Balu Elastics', trace = null } = {}) {
  const c = await Complaint.findById(complaintId)
    .populate('customer', 'name').populate('elastic', 'name').populate('job', 'jobOrderNo date status').lean();
  if (!c) { const e = new Error('Complaint not found'); e.status = 404; throw e; }
  const claude = anthropic();
  if (!claude) return { text: templateReply(c, company), aiGenerated: false, aiSuggestion: null };
  const facts = [
    `Customer: ${c.customer?.name || ''}`,
    `Reported on: ${dmy(c.date)}`,
    `Category: ${c.category}`,
    `What they said: ${c.reason}`,
    c.elastic?.name ? `Product: ${c.elastic.name}` : 'Product: not named by the customer',
    c.job?.jobOrderNo ? `Our job: ${c.job.jobOrderNo}, made ${dmy(c.job.date)}` : '',
    `Status: ${c.status}`,
    c.resolution ? `Resolution (what we found and decided): ${c.resolution}` : 'Resolution: not yet decided',
    c.feedback ? `Notes since: ${c.feedback.slice(-600)}` : '',
    trace?.ok ? `Our investigation so far: ${trace.summary?.lots ?? 0} yarn lot(s) traced${trace.lots?.length ? ` (shades: ${[...new Set(trace.lots.map((l) => l.shade).filter(Boolean))].join(', ') || 'n/a'})` : ''}.` : '',
    `Company: ${company}`,
  ].filter(Boolean).join('\n');
  const startedAt = Date.now();
  try {
    const msg = await claude.messages.create({ model: TEXT_MODEL, max_tokens: 500, system: REPLY_PROMPT, messages: [{ role: 'user', content: facts }] });
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new Error('empty reply');
    const aiSuggestion = await ledger.record({
      surface: 'complaint-reply', model: TEXT_MODEL, promptVersion: promptVersion('complaint-reply'), refType: 'complaint', refId: c._id,
      proposed: { text }, latencyMs: Date.now() - startedAt, usage: msg.usage,
    });
    return { text, aiGenerated: true, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null };
  } catch (err) {
    await ledger.record({ surface: 'complaint-reply', model: TEXT_MODEL, promptVersion: promptVersion('complaint-reply'), latencyMs: Date.now() - startedAt, error: err?.message || String(err) });
    return { text: templateReply(c, company), aiGenerated: false, aiSuggestion: null };
  }
}

module.exports = { intake, draftReply, keywordCategory, templateReply, candidates, INTAKE_PROMPT, REPLY_PROMPT };
