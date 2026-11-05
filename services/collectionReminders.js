'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYMENT REMINDERS ON A SCHEDULE
//
//  Once a day, at the set hour (factory time), a WhatsApp reminder to
//  each customer past due who is due one: past due by at least the set
//  days, at the "remind" step of the ladder (services/collections.js —
//  a debt old enough to need a call or the owner is left to a person),
//  with no live promise, and not contacted — reminded, called, or
//  replied — in the last `everyDays`. The reminder is drafted as the
//  office's own is (gentle, or firm past three weeks), sent, and kept in
//  the customer's history like any other.
//
//  Off until an admin turns it on (AccountsSettings.collections.autoRemind).
//  The day is claimed on the settings row before anything is sent, so
//  two server processes never both send it. At most MAX_PER_DAY a day.
// ══════════════════════════════════════════════════════════════════

const AccountsSettings = require('../models/AccountsSettings');
const CollectionNote = require('../models/CollectionNote');
const collections = require('./collections');

const MAX_PER_DAY = Number(process.env.COLLECTION_REMINDERS_MAX || 30);
const FACTORY_TZ = process.env.FACTORY_TZ || 'Asia/Kolkata';
const EVERY_MS = 15 * 60_000;

function factoryNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: FACTORY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Who would be reminded now, and why the rest are not. */
async function due(cfg, now = new Date()) {
  const rows = await collections.overdue({ includeHeld: true });
  const since = new Date(now.getTime() - (cfg.everyDays || 7) * 86_400_000);
  const recent = new Set((await CollectionNote.find({ createdAt: { $gte: since } }).distinct('customer')).map(String));
  const send = [];
  const skip = [];
  for (const r of rows) {
    const why = r.held ? `promised to pay by ${new Date(r.promise.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`
      : recent.has(String(r.party)) ? `contacted in the last ${cfg.everyDays || 7} days`
        : r.oldestDays < (cfg.minOverdueDays ?? 3) ? `only ${r.oldestDays} days past due`
          : r.next.action !== 'remind' ? `${r.next.label.toLowerCase()} — for a person, not a reminder`
            : !collections.e164(r.contact.phone || r.contact.accountantPhone) ? 'no phone on file' : null;
    if (why) skip.push({ party: r.party, partyName: r.partyName, overdue: r.overdue, why });
    else send.push(r);
  }
  return { send: send.slice(0, MAX_PER_DAY), skip, more: Math.max(0, send.length - MAX_PER_DAY) };
}

/**
 * Send today's reminders when it is time and they have not gone. `force`
 * (the admin's "Send today's now") skips the hour, still once a day.
 */
async function run({ now = new Date(), force = false } = {}) {
  const s = await require('./booksLock').getSettings();
  const cfg = s.collections?.autoRemind || {};
  if (!cfg.enabled) return { sent: 0, why: 'off' };
  const { dateKey, hour } = factoryNow(now);
  if (!force && hour < (cfg.hour ?? 11)) return { sent: 0, why: 'not yet' };
  const claimed = await AccountsSettings.findOneAndUpdate(
    { key: 'accounts', 'collections.autoRemind.lastRunDate': { $ne: dateKey } },
    { $set: { 'collections.autoRemind.lastRunDate': dateKey } },
  ).lean();
  if (!claimed) return { sent: 0, why: 'sent today already' };

  const { sendWhatsApp } = require('../utils/whatsapp');
  const company = (await require('./documentSettings').getDocumentSettings().catch(() => ({}))).companyName || 'Balu Elastics';
  const list = await due(cfg, now);
  const out = [];
  for (const r of list.send) {
    const to = collections.e164(r.contact.phone || r.contact.accountantPhone);
    const { message } = await collections.draft(r, { company, tone: r.next.tone });
    const res = await sendWhatsApp(to, message);
    const result = res.sent ? 'sent' : res.dryRun ? 'dry_run' : `error: ${res.error || 'not sent'}`;
    await collections.log({ customer: r.party, kind: 'reminder', channel: 'whatsapp', tone: r.next.tone, to, message, result, user: { _id: null, name: 'Scheduled reminder' } });
    out.push({ party: r.party, partyName: r.partyName, to, overdue: r.overdue, result });
  }
  return { sent: out.filter((x) => x.result === 'sent').length, dateKey, reminders: out, skipped: list.skip.length, more: list.more };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.COLLECTION_REMINDERS === 'off') return null;
  timer = setInterval(() => { run().catch((err) => console.error('[collection-reminders] failed:', err?.message)); }, EVERY_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { run, due, start, stop, factoryNow };
