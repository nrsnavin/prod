'use strict';
// ══════════════════════════════════════════════════════════════════
//  STATEMENT LINES THE RULES COULD NOT PLACE, PLACED BY THE MODEL
//
//  One call per forty lines. The model sees each line (date, money in or
//  out, amount, narration, reference), who is on file, the open invoices
//  and bills, our own accounts, the expense heads, and lines people
//  placed before. For each line it says what it is:
//
//    customer / supplier   who, and which of their documents it names
//                          ("INV 701 702", "bill SY/118") — short forms
//                          a substring rule cannot see
//    transfer              money between two of our own accounts
//    expense               a payment to someone not on file, and its head
//                          (the electricity board → Electricity)
//    income                money in from someone not on file: interest,
//                          or other income by name
//    unknown               nothing to go on
//
//  Nothing it says is taken on trust: a party must be on file by that
//  exact name, a document must be that party's and open, an account one
//  of ours other than this one, a head one on file. What survives
//  becomes a suggestion with a capped confidence and "AI:" in its
//  reason, for a person to confirm — never posted without one. The
//  allocation is ours: the documents it named, settled oldest first up
//  to the amount, else an exact set of the party's open documents, else
//  oldest first.
// ══════════════════════════════════════════════════════════════════

const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CHUNK = 40;
const MIN_CONFIDENCE = 0.5;
const KINDS = new Set(['customer', 'supplier', 'transfer', 'expense', 'income', 'unknown']);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

function promptFor({ rows, customers, suppliers, openDocs, accounts, thisAccount, heads, examples }) {
  return [
    'You place lines from an Indian elastic-weaving factory\'s bank statement into its books.',
    'For each line, say what it is:',
    '  "customer": money in from a customer on the list (sometimes money back out to one).',
    '  "supplier": money out to a supplier on the list (sometimes a refund in from one).',
    '  "transfer": money between this account and another of OUR accounts listed (cash withdrawn, cash deposited, a sweep or transfer).',
    '  "expense": money out to someone not on the lists — electricity, rent, fuel, bank charges, telephone, wages, taxes — with the head it belongs under, from the heads listed.',
    '  "income": money in from someone not on the lists — "interest" for bank interest, else "other".',
    '  "unknown": nothing in the narration to go on.',
    'Bank narrations are terse: NEFT/RTGS/IMPS/UPI codes, IFSC codes, truncated names, a proprietor\'s own name for his firm, invoice numbers written short ("INV 701", "701/702", "BILL 118").',
    'Use the earlier lines people placed as the best guide to how a party appears in narrations.',
    'Never invent a name, document, account or head that is not in the lists; use null instead. Be honest about confidence.',
    'Return ONLY JSON: {"rows":[{"index":0,"kind":"customer","party":"exact name or null","docs":["exact document numbers"],"account":"exact account name or null","head":"exact head or null","payee":"short name of who it is, for expense/income","income":"interest|other|null","confidence":0.0,"why":"a few words"}]}',
    '',
    `This account: ${thisAccount}`,
    `Our other accounts: ${JSON.stringify(accounts.map((a) => a.name))}`,
    `Customers: ${JSON.stringify(customers.map((c) => c.name).slice(0, 300))}`,
    `Suppliers: ${JSON.stringify(suppliers.map((s) => s.name).slice(0, 300))}`,
    `Expense heads: ${JSON.stringify(heads.map((h) => h.name))}`,
    `Open documents (number | party | outstanding): ${JSON.stringify(openDocs.slice(0, 250).map((d) => `${d.docNo} | ${d.partyName} | ${d.outstanding}`))}`,
    `Lines people placed before (narration → what it was): ${JSON.stringify(examples.slice(0, 40))}`,
    '',
    `Lines: ${JSON.stringify(rows.map((r) => ({ index: r.index, date: ymd(r.date), direction: r.direction, amount: r.amount, narration: r.narration, ref: r.ref || '' })))}`,
  ].join('\n');
}

function parseJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return { rows: [] };
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return { rows: [] }; }
}

/**
 * Turn one answer into a suggestion, or null when it does not hold up.
 * @param ctx { recvByParty, payByParty, customers, suppliers, accounts, heads, subsetFor, fifo, alloc, cashAccount }
 */
function suggestionFrom(row, hit, ctx) {
  const conf = Math.max(0, Math.min(1, Number(hit.confidence) || 0));
  if (!KINDS.has(hit.kind) || hit.kind === 'unknown' || conf < MIN_CONFIDENCE) return null;
  const why = String(hit.why || '').trim().slice(0, 140);
  const reason = (s) => `AI: ${s}${why ? ` — ${why}` : ''}`;

  if (hit.kind === 'customer' || hit.kind === 'supplier') {
    const partyType = hit.kind;
    // Money in is from a customer and out to a supplier; the other way round is a refund, left to a person.
    if ((partyType === 'customer') !== (row.direction === 'in')) return null;
    const list = partyType === 'customer' ? ctx.customers : ctx.suppliers;
    const party = list.find((p) => p.name === hit.party);
    if (!party) return null;
    const group = (partyType === 'customer' ? ctx.recvByParty : ctx.payByParty).find((g) => String(g.party) === String(party._id));
    const docs = group?.docs || [];
    const named = (Array.isArray(hit.docs) ? hit.docs : []).map((no) => docs.find((d) => d.docNo === no)).filter(Boolean);
    let pairs; let cap; let what;
    const namedTotal = r2(named.reduce((t, d) => t + d.outstanding, 0));
    if (named.length && Math.abs(namedTotal - row.amount) < 1) { pairs = named.map((doc) => ({ doc })); cap = 0.85; what = `names ${named.map((d) => d.docNo).join(' + ')}, amount exact`; }
    else if (named.length && namedTotal > row.amount) { pairs = ctx.fifo(named, row.amount); cap = 0.75; what = `names ${named.map((d) => d.docNo).join(' + ')}, part paid`; }
    else {
      const exact = ctx.subsetFor(docs, row.amount);
      if (exact) { pairs = exact.map((doc) => ({ doc })); cap = 0.8; what = `${party.name}, amount matches ${exact.map((d) => d.docNo).join(' + ')}`; }
      else if (docs.length) { pairs = ctx.fifo(docs, row.amount); cap = 0.6; what = `${party.name}, allocated oldest first`; }
      else { pairs = []; cap = 0.55; what = `${party.name}, nothing open: stays on account`; }
    }
    return { partyType, party: party._id, partyName: party.name, allocations: ctx.alloc(pairs), confidence: Math.min(conf, cap), reason: reason(what), byModel: true };
  }

  if (hit.kind === 'transfer') {
    const other = ctx.accounts.find((a) => a.name === hit.account);
    if (!other) return null;
    return { kind: 'contra', partyType: 'other', party: null, partyName: other.name, account: other._id, accountName: other.name, allocations: [], confidence: Math.min(conf, 0.85), reason: reason(`${row.direction === 'out' ? 'to' : 'from'} ${other.name}`), byModel: true };
  }

  const payee = String(hit.payee || '').trim().slice(0, 60);
  if (hit.kind === 'expense') {
    if (row.direction !== 'out') return null;
    const head = ctx.heads.find((h) => h.name === hit.head);
    if (!head || !payee) return null;
    return { partyType: 'other', party: null, partyName: payee, head: head._id, headName: head.name, allocations: [], confidence: Math.min(conf, 0.8), reason: reason(`${payee}, under ${head.name}`), byModel: true };
  }

  // income
  if (row.direction !== 'in') return null;
  const interest = hit.income === 'interest';
  if (!interest && !payee) return null;
  return { partyType: 'other', party: null, partyName: interest ? (payee || 'Bank interest') : payee, ...(interest ? { incomeLedger: 'interest' } : {}), allocations: [], confidence: Math.min(conf, 0.8), reason: reason(interest ? 'interest received' : `other income from ${payee}`), byModel: true };
}

/**
 * @param rows   the lines still unmatched (from match())
 * @param ctx    what match() already loaded, plus accounts (ours, not this one),
 *               heads, examples and thisAccount (its name)
 * @returns Map index → suggestion
 */
async function place(rows, ctx) {
  const out = new Map();
  const claude = anthropic();
  if (!claude || !rows.length) return out;
  const openDocs = [...ctx.recv, ...ctx.pay];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const startedAt = Date.now();
    try {
      const resp = await claude.messages.create({
        model: TEXT_MODEL, max_tokens: 4096,
        messages: [{ role: 'user', content: promptFor({ rows: part, customers: ctx.customers, suppliers: ctx.suppliers, openDocs, accounts: ctx.accounts, thisAccount: ctx.thisAccount, heads: ctx.heads, examples: ctx.examples }) }],
      });
      const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const parsed = parseJson(text);
      let kept = 0;
      for (const hit of parsed.rows || []) {
        const row = part.find((r) => r.index === hit.index);
        if (!row || out.has(row.index)) continue;
        const s = suggestionFrom(row, hit, ctx);
        if (s) { out.set(row.index, s); kept += 1; }
      }
      await ledger.record({ surface: 'bank-statement-match', model: TEXT_MODEL, promptVersion: promptVersion('bank-statement-match'), proposed: { rows: part.length, answered: (parsed.rows || []).length, kept }, latencyMs: Date.now() - startedAt, usage: resp.usage });
    } catch (err) {
      await ledger.record({ surface: 'bank-statement-match', model: TEXT_MODEL, promptVersion: promptVersion('bank-statement-match'), latencyMs: Date.now() - startedAt, error: err.message });
    }
  }
  return out;
}

module.exports = { place, suggestionFrom, promptFor, parseJson };
