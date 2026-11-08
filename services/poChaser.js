'use strict';
// ══════════════════════════════════════════════════════════════════
//  CHASING SUPPLIERS FOR LATE PURCHASE ORDERS
//
//  Customers who pay late are followed up; suppliers who deliver late
//  were not, though late yarn stops a loom. This is the same loop for
//  purchases:
//
//    overdue()      open POs past the date asked for, with what is still
//                   to come, the order or job each was raised for, and
//                   whether a chaser is due;
//    draft()/send() the WhatsApp chaser, written from the PO itself;
//    handleReply()  the supplier's answer read for a dispatch date —
//                   kept on the PO as their promise, the office told,
//                   and any customer order that date now puts at risk
//                   named.
//
//  `expectedDate` stays what we asked for; the promise sits beside it in
//  `chase.promisedDate`. A PO with a promise still to come is not chased
//  until that day passes. Each morning the chasers can go by themselves
//  (ProductionSettings.poChase.auto, off by default) — once a day,
//  claimed like the daily reports.
// ══════════════════════════════════════════════════════════════════

const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const ProductionSettings = require('../models/ProductionSettings');
const factoryDay = require('../utils/factoryDay');
const { e164 } = require('./collections');
const { dateIn } = require('./collectionReply');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const SURFACE = 'po-chase-reply';
const KINDS = ['promise', 'dispatched', 'problem', 'other'];
const DAY = 86_400_000;
const AI_WAIT_MS = Number(process.env.PO_CHASE_AI_MS) || 6000;
const EVERY_MS = 15 * 60_000;

const qty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const ymd = (d) => factoryDay.ymd(d);

async function settings() {
  const s = await ProductionSettings.findOneAndUpdate({ key: 'production' }, { $setOnInsert: { key: 'production' } }, { upsert: true, new: true }).lean();
  return { auto: false, hour: 10, gapDays: 2, acknowledge: false, ...(s.poChase || {}) };
}

async function company() {
  try { return (await require('./documentSettings').getPdfBranding()).company || ''; } catch { return ''; }
}

/** What is still to come on a PO (populated items). */
function pendingOf(po) {
  return (po.items || []).map((it) => ({
    material: it.rawMaterial?.name || 'Material', unit: it.rawMaterial?.unit || '',
    ordered: Number(it.quantity) || 0, received: Number(it.receivedQuantity) || 0,
    pending: Math.max(0, (Number(it.quantity) || 0) - (Number(it.receivedQuantity) || 0)),
    belowMinimum: it.rawMaterial ? Number(it.rawMaterial.stock) <= Number(it.rawMaterial.minStock || 0) : false,
  })).filter((x) => x.pending > 0.0005);
}

/** The chaser for one PO, from the PO itself. */
function draftText(po, { name = '', now = new Date() } = {}) {
  const s = po.supplier || {};
  const lines = pendingOf(po).map((p) => `• ${p.material} — ${qty(p.pending)} ${p.unit}`.trim());
  const promised = po.chase?.promisedDate;
  return [
    `Hello ${s.contactPerson || s.name || ''},`.replace(/\s+,/, ','),
    `Our PO ${po.poNo ? `#${po.poNo}` : ''} dated ${dmy(po.date)} was due on ${dmy(po.expectedDate)}${promised && promised < factoryDay.calendarDay(now) ? `, and you had promised dispatch by ${dmy(promised)}` : ''}. Still to come:`.replace('PO  ', 'PO '),
    ...lines,
    'Please reply with the date you will dispatch.',
    name ? `— ${name}` : '',
  ].filter(Boolean).join('\n');
}

const waLink = (phone, text) => {
  const digits = String(e164(phone) || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : '';
};

/** Open POs past the date asked for, oldest first. */
async function overdue({ now = new Date() } = {}) {
  const today = factoryDay.calendarDay(now);
  const cfg = await settings();
  const name = await company();
  const pos = await PurchaseOrder.find({ status: { $in: ['Open', 'Partial'] }, expectedDate: { $lt: today } })
    .populate('supplier', 'name phoneNumber contactPerson')
    .populate('items.rawMaterial', 'name unit stock minStock')
    .populate('forOrder', 'orderNo supplyDate')
    .populate('forJob', 'jobOrderNo')
    .sort({ expectedDate: 1 })
    .lean();
  const rows = [];
  for (const po of pos) {
    const pending = pendingOf(po);
    if (!pending.length) continue;
    const promised = po.chase?.promisedDate ? factoryDay.calendarDay(po.chase.promisedDate) : null;
    const waiting = promised && promised >= today; // they gave a date still to come
    const phone = e164(po.supplier?.phoneNumber);
    const lastAt = po.chase?.lastAt ? new Date(po.chase.lastAt) : null;
    const rested = !lastAt || now - lastAt >= cfg.gapDays * DAY - 60 * 60_000;
    const text = draftText(po, { name, now });
    const order = po.forOrder ? { orderNo: po.forOrder.orderNo, supplyDate: po.forOrder.supplyDate } : null;
    rows.push({
      _id: po._id, poNo: po.poNo, date: po.date, expectedDate: po.expectedDate,
      supplier: { _id: po.supplier?._id, name: po.supplier?.name || '', phone },
      daysLate: Math.round((today - factoryDay.calendarDay(po.expectedDate)) / DAY),
      pending, forOrder: order, forJob: po.forJob ? { jobOrderNo: po.forJob.jobOrderNo } : null,
      promisedDate: po.chase?.promisedDate || null, chaseCount: po.chase?.count || 0, lastChasedAt: lastAt,
      history: (po.chase?.history || []).slice(-6),
      state: waiting ? 'promised' : 'overdue',
      chaseDue: !waiting && rested && !!phone,
      why: !phone ? 'No phone number on the supplier' : waiting ? `Promised by ${dmy(promised)}` : !rested ? `Chased ${dmy(lastAt)}` : '',
      atRisk: !!(order?.supplyDate && promised && promised > factoryDay.calendarDay(order.supplyDate)),
      draft: text, waLink: phone ? waLink(phone, text) : '',
    });
  }
  return rows;
}

/** Send the chaser for one PO on WhatsApp, and note it on the PO. */
async function send(poId, { by = '', now = new Date() } = {}) {
  const po = await PurchaseOrder.findById(poId)
    .populate('supplier', 'name phoneNumber contactPerson')
    .populate('items.rawMaterial', 'name unit stock minStock')
    .lean();
  if (!po) return { sent: false, error: 'Purchase order not found' };
  if (!['Open', 'Partial'].includes(po.status)) return { sent: false, error: `This PO is ${po.status.toLowerCase()}` };
  if (!pendingOf(po).length) return { sent: false, error: 'Nothing is still to come on this PO' };
  const to = e164(po.supplier?.phoneNumber);
  if (!to) return { sent: false, error: 'The supplier has no phone number' };
  const text = draftText(po, { name: await company(), now });
  const { sendWhatsApp } = require('../utils/whatsapp');
  const r = await sendWhatsApp(to, text);
  const status = r.sent ? 'sent' : r.dryRun ? 'dry_run' : 'error';
  await PurchaseOrder.updateOne({ _id: po._id }, {
    ...(r.sent || r.dryRun ? { $inc: { 'chase.count': 1 }, $set: { 'chase.lastAt': now } } : {}),
    $push: { 'chase.history': { $each: [{ at: now, kind: 'sent', text, by, status }], $slice: -30 } },
  });
  const Notification = require('../models/Notification');
  await Notification.create({ event: 'poChase', recipient: to, channel: 'whatsapp', body: text, status, reason: r.error || (r.dryRun ? 'provider not configured' : `PO ${po.poNo || po._id}`), providerId: r.providerId }).catch(() => null);
  return { sent: !!r.sent, dryRun: !!r.dryRun, error: r.error || '', text, to };
}

/** Every chaser due today; returns what went. */
async function sendDue({ now = new Date(), by = 'Automatic' } = {}) {
  const rows = (await overdue({ now })).filter((r) => r.chaseDue);
  const out = [];
  for (const r of rows) out.push({ poNo: r.poNo, ...(await send(r._id, { by, now })) });
  return out;
}

// ── The supplier's reply ─────────────────────────────────────────

/** The supplier whose number this is. */
async function supplierForPhone(phone) {
  const want = e164(phone);
  if (!want) return null;
  const all = await Supplier.find({ phoneNumber: { $nin: ['', null] } }).select('name phoneNumber contactPerson').lean();
  return all.find((s) => e164(s.phoneNumber) === want) || null;
}

function keywordRead(text, today = new Date()) {
  const t = String(text || '').toLowerCase();
  const d = dateIn(t, factoryDay.calendarDay(today)); // India's today, at its calendar midnight
  let kind = 'other';
  if (/\b(dispatched|despatched|sent (today|already|it)|shipped|loaded|on the way|in transit|lr (no|number)|lorry)\b|அனுப்பி/.test(t)) kind = 'dispatched';
  else if (/\b(cannot|can't|cant|unable|not possible|no stock|out of stock|shortage|price (increase|revised|hike)|rate (increase|revised)|delay(ed)? due|power cut|strike)\b/.test(t) && !d) kind = 'problem';
  else if (d || /\b(will (send|dispatch|deliver|ship)|by (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday)|next week)\b/.test(t)) kind = 'promise';
  const poNo = (t.match(/\bpo\s*(?:no\.?|number|#)?\s*[:#-]?\s*(\d{1,7})\b/) || [])[1];
  return { kind, date: d ? factoryDay.ymd(d) : null, poNo: poNo ? Number(poNo) : null, summary: '', ai: false };
}

const parseJson = (text) => { const s = String(text || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}'); if (a < 0 || b < 0) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } };

/** What the reply says. Never throws: keywords stand when the model is slow, off or wrong. */
async function readReply(text, { today = new Date(), refId = null } = {}) {
  const base = keywordRead(text, today);
  const claude = anthropic();
  if (!claude) return base;
  const startedAt = Date.now();
  try {
    const prompt = [
      `Today is ${factoryDay.ymd(today)}. A yarn or rubber supplier of an elastic manufacturer in Tamil Nadu replied on WhatsApp to a`,
      'reminder that a purchase order is late. The reply may be English, Tamil or Tanglish. Return ONLY JSON:',
      '{"kind":"promise","date":"2026-11-15","poNo":123,"summary":"Will dispatch on 15 Nov","confidence":0.8}',
      `- kind: one of ${KINDS.join(', ')}. promise = will dispatch or deliver by a date; dispatched = already sent;`,
      '  problem = cannot supply, shortage, price change or other trouble; other = anything else.',
      '- date: the dispatch/delivery day (YYYY-MM-DD, worked out from today) or the day it was sent, else null.',
      '- poNo: a PO number when mentioned, else null. summary: at most 80 characters, English.',
      '', `Reply:\n"""\n${String(text).slice(0, 1500)}\n"""`,
    ].join('\n');
    const call = claude.messages.create({ model: TEXT_MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
    const msg = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), AI_WAIT_MS))]);
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw || !KINDS.includes(raw.kind)) throw new Error('model returned no kind');
    const out = {
      kind: raw.kind,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? raw.date : base.date,
      poNo: Number.isInteger(Number(raw.poNo)) && Number(raw.poNo) > 0 ? Number(raw.poNo) : base.poNo,
      summary: String(raw.summary || '').slice(0, 100), ai: true,
    };
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), refType: 'Supplier', refId, proposed: { kind: out.kind, date: out.date }, latencyMs: Date.now() - startedAt, usage: msg.usage }).catch(() => null);
    return out;
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) }).catch(() => null);
    return base;
  }
}

/** Which of the supplier's open POs a reply is about. */
async function poForReply(supplierId, read) {
  const open = await PurchaseOrder.find({ supplier: supplierId, status: { $in: ['Open', 'Partial'] } })
    .populate('forOrder', 'orderNo supplyDate').sort({ 'chase.lastAt': -1, expectedDate: 1 }).lean();
  if (!open.length) return null;
  if (read.poNo) { const hit = open.find((p) => p.poNo === read.poNo); if (hit) return hit; }
  return open.find((p) => p.chase?.lastAt) || open[0];
}

const WORDS = {
  promise: (r) => `promises dispatch${r.date ? ` by ${dmy(r.date)}` : ''}`,
  dispatched: (r) => `says it is dispatched${r.date ? ` (${dmy(r.date)})` : ''}`,
  problem: () => 'reports a problem — call them',
  other: () => 'replied',
};

/**
 * A supplier's WhatsApp reply: kept on the PO, a date taken as their
 * promise, the office told. @returns { read, po, ack }
 */
async function handleReply({ from, text, supplier, now = new Date() }) {
  const read = await readReply(text, { today: now, refId: supplier._id });
  const po = await poForReply(supplier._id, read);
  if (!po) return { read, po: null, ack: '' };
  const promised = (read.kind === 'promise' || read.kind === 'dispatched') && read.date ? factoryDay.calendarDay(read.date) : null;
  await PurchaseOrder.updateOne({ _id: po._id }, {
    ...(promised ? { $set: { 'chase.promisedDate': promised } } : {}),
    $push: { 'chase.history': { $each: [{ at: now, kind: 'reply', text: String(text).slice(0, 1000), read: { kind: read.kind, date: read.date ? factoryDay.calendarDay(read.date) : null, summary: read.summary }, by: supplier.name }], $slice: -30 } },
  });
  const risk = promised && po.forOrder?.supplyDate && promised > factoryDay.calendarDay(po.forOrder.supplyDate)
    ? `\n⚠️ Order #${po.forOrder.orderNo} is due ${dmy(po.forOrder.supplyDate)} — this date may make it late.` : '';
  const { notify } = require('../utils/notify');
  await notify('supplierReply', {
    body: `📦 *${supplier.name}* ${WORDS[read.kind](read)} for PO #${po.poNo || ''}:\n"${String(text).slice(0, 300)}"${risk}`,
    _entity: { type: 'PurchaseOrder', id: po._id },
  }).catch(() => null);
  const cfg = await settings();
  const ack = cfg.acknowledge && promised ? `Thank you — noted dispatch by ${dmy(promised)} for PO #${po.poNo}.` : '';
  return { read, po: { _id: po._id, poNo: po.poNo }, promised: promised ? ymd(promised) : null, atRisk: !!risk, ack };
}

// ── Each morning, by itself (when turned on) ─────────────────────
async function tick(now = new Date()) {
  const cfg = await settings();
  if (!cfg.auto) return { ran: false, why: 'off' };
  const mins = require('./scheduledReports').indiaMinutes(now);
  if (mins < cfg.hour * 60 || mins > cfg.hour * 60 + 180) return { ran: false, why: 'not now' };
  const ScheduledRun = require('../models/ScheduledRun');
  const day = factoryDay.ymd(now);
  try { await ScheduledRun.create({ key: `poChase:${day}`, task: 'poChase', day }); } catch (err) { if (err?.code === 11000) return { ran: false, why: 'already sent today' }; throw err; }
  const sent = await sendDue({ now });
  await ScheduledRun.updateOne({ key: `poChase:${day}` }, { $set: { ok: true } });
  return { ran: true, sent };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.PO_CHASE === 'off') return null;
  timer = setInterval(() => { tick().catch((err) => console.error('[po-chase] failed:', err?.message)); }, EVERY_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { overdue, send, sendDue, draftText, handleReply, readReply, keywordRead, supplierForPhone, settings, tick, start, stop, SURFACE };
