'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANK LINES THAT POST THEMSELVES
//
//  A remembered payer or payee (models/BankAlias.js: "TNEB" is the
//  electricity board, "R K TRADING" is Sunrise Garments) is suggested
//  for every line carrying its text, and a person posts it. Each time a
//  person posts such a line exactly as suggested — the same party, the
//  same documents and amounts, the same head — the payer counts one
//  more; a change of any of it starts the count again.
//
//  Once a payer has been posted unchanged `after` times running (5 by
//  default), its next lines post themselves when a statement comes in
//  (uploaded, mailed or by SFTP) — if the books are set to allow it
//  (off by default), and only:
//    · below the amount limit (₹50,000 by default);
//    · a head or income for someone not on file, or a party whose open
//      documents the amount settles exactly — never "oldest first" or
//      money left on account, which a person may well have changed;
//    · through the same door a person posts by (services/statementPosting.js),
//      so the books lock, the request id and the line's identity all hold.
//  Each such voucher says so on its line, and is cancelled like any
//  other, which gives the line back.
// ══════════════════════════════════════════════════════════════════

const BankAlias = require('../models/BankAlias');
const BankStatement = require('../models/BankStatement');
const { r2 } = require('../utils/money');

const DEFAULTS = { enabled: false, after: 5, upTo: 50000 };

async function settings() {
  const s = await require('./booksLock').getSettings().catch(() => null);
  const b = s?.bankLines || {};
  return { enabled: !!b.postLearned, after: Number(b.learnedAfter) || DEFAULTS.after, upTo: b.learnedUpTo != null ? Number(b.learnedUpTo) : DEFAULTS.upTo };
}

/** Did the person post the line exactly as the payer suggested it? */
function sameAsSuggested(s, r) {
  const pt = r.partyType === 'customer' || r.partyType === 'supplier' ? r.partyType : 'other';
  if (pt !== s.partyType) return false;
  if ((r.adjustments || []).length) return false;
  if (r.contra) return false;
  if (pt === 'other') return String(r.head || '') === String(s.head || '') && String(r.incomeLedger || '') === String(s.incomeLedger || '');
  if (String(r.party || '') !== String(s.party || '')) return false;
  const key = (xs) => (xs || []).map((a) => `${a.docType}:${a.doc}:${r2(a.amount)}`).sort().join('|');
  return key(r.allocations) === key(s.allocations);
}

/**
 * A person posted a line the payer had suggested: one more unchanged,
 * or the count starts again. Never throws: the voucher stands either way.
 */
async function score(suggestion, row) {
  if (!suggestion?.remembered) return null;
  try {
    const same = sameAsSuggested(suggestion, row);
    await BankAlias.updateOne({ _id: suggestion.remembered }, same
      ? { $inc: { acceptedUnchanged: 1 }, $set: { lastAcceptedAt: new Date() } }
      : { $set: { acceptedUnchanged: 0, changedAt: new Date() } });
    return same;
  } catch {
    return null;
  }
}

/** Whether a matched line may post itself, and why not when it may not. */
function eligible(line, alias, cfg) {
  const s = line.suggestion;
  if (line.status !== 'matched' || !s?.remembered || !alias) return { ok: false };
  if ((alias.acceptedUnchanged || 0) < cfg.after) return { ok: false };
  if (line.amount > cfg.upTo) return { ok: false, why: `Above the ₹${cfg.upTo.toLocaleString('en-IN')} a line may post itself` };
  if (s.partyType === 'other') return { ok: !!(s.head || s.incomeLedger || s.partyName) };
  if (!s.party) return { ok: false };
  const allocated = r2((s.allocations || []).reduce((t, a) => t + (a.amount || 0), 0));
  if (!(s.confidence >= 0.9) || !s.allocations?.length || Math.abs(allocated - line.amount) > 0.005) return { ok: false, why: 'Does not settle open documents exactly: for a person to check' };
  return { ok: true };
}

/**
 * Post a stored statement's lines whose payer has earned it.
 * → { posted: [{ index, voucherNo, text }], skipped: [{ index, why }] }
 */
async function postLearned(statementId, accountId, { via = 'upload' } = {}) {
  const cfg = await settings();
  const out = { posted: [], skipped: [] };
  if (!cfg.enabled) return out;
  const doc = await BankStatement.findById(statementId).lean();
  if (!doc) return out;
  const ids = [...new Set(doc.lines.filter((l) => l.status === 'matched' && l.suggestion?.remembered).map((l) => String(l.suggestion.remembered)))];
  if (!ids.length) return out;
  const aliases = new Map((await BankAlias.find({ _id: { $in: ids } }).lean()).map((a) => [String(a._id), a]));
  const { postRow } = require('./statementPosting');
  const req = { user: { _id: null, name: 'Posted by itself (learned)', role: 'accounts' }, body: {} };
  for (const line of doc.lines) {
    const alias = line.suggestion?.remembered ? aliases.get(String(line.suggestion.remembered)) : null;
    const e = eligible(line, alias, cfg);
    if (!e.ok) { if (e.why) out.skipped.push({ index: line.index, why: e.why }); continue; }
    const s = line.suggestion;
    const note = `Posted by itself: lines with "${alias.text}" were posted unchanged ${alias.acceptedUnchanged} times running`;
    try {
      const r = await postRow({
        accountId, statement: doc, req, auto: true, note,
        row: {
          index: line.index, partyType: s.partyType, party: s.party || undefined, partyName: s.partyName, head: s.head || undefined, incomeLedger: s.incomeLedger || undefined,
          mode: 'bank', allocations: (s.allocations || []).map((a) => ({ docType: a.docType, doc: a.doc, amount: a.amount })),
          requestId: `learned:${statementId}:${line.index}`,
        },
      });
      if (r.ok && !r.replay) {
        out.posted.push({ index: line.index, voucherNo: r.voucherNo, text: alias.text });
        await BankAlias.updateOne({ _id: alias._id }, { $inc: { autoPosted: 1 }, $set: { lastAutoPostedAt: new Date() } });
      }
    } catch (err) {
      out.skipped.push({ index: line.index, why: err.message });
      await BankStatement.updateOne({ _id: doc._id, 'lines.index': line.index }, { $set: { 'lines.$.note': `Not posted by itself: ${err.message}`.slice(0, 200) } });
    }
  }
  if (out.posted.length) console.log(`[learned-posting] ${out.posted.length} line(s) posted by themselves on ${doc.accountName} (${via})`);
  return out;
}

/** The remembered payers, how near each is to posting itself: for the settings card. */
async function progress() {
  const cfg = await settings();
  const rows = await BankAlias.find({}).select('text direction partyType partyName headName acceptedUnchanged autoPosted lastAutoPostedAt lastMatchedAt').sort({ acceptedUnchanged: -1, text: 1 }).limit(300).lean();
  return {
    ...cfg,
    payers: rows.map((a) => ({ ...a, acceptedUnchanged: a.acceptedUnchanged || 0, autoPosted: a.autoPosted || 0, earned: (a.acceptedUnchanged || 0) >= cfg.after })),
  };
}

module.exports = { postLearned, score, sameAsSuggested, eligible, progress, settings, DEFAULTS };
