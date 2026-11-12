'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BANK'S STATEMENTS, FROM A MAILBOX
//
//  Corporate net banking can email a statement on a schedule — daily,
//  or several times a day — as CSV or Excel. Point it at a mailbox the
//  ERP reads (config/.env, never the database):
//
//    BANK_FEED_IMAP_HOST     e.g. imap.hostinger.com
//    BANK_FEED_IMAP_PORT     993 (default)
//    BANK_FEED_IMAP_USER     statements@baluelastics.com
//    BANK_FEED_IMAP_PASS     that mailbox's password
//    BANK_FEED_MAILBOX       INBOX (default)
//    BANK_FEED_SENDERS       who may send statements, comma-separated:
//                            full addresses or @domain (e.g. @kotak.com).
//                            Others are recorded and left alone.
//    BANK_FEED_EVERY_MIN     15 (default); 0 turns the timer off (the
//                            cron route and the "check now" button remain)
//
//  Every few minutes the mailbox is read for mail of the last ten days.
//  Each message is handled once (its Message-ID is recorded, so however
//  many server processes look, and however often), its CSV / Excel
//  attachments go through the same import as an upload, into the bank
//  account whose number is in the mail (or whose statement address sent
//  it, or the only one there is), and only lines not seen before are
//  kept — daily statements overlap. Lines then wait in the inbox,
//  matched where they could be, for a person to confirm.
//
//  Optionally (Accounts → Bank, admin) a line the matcher is sure of —
//  a document number in its narration, the amount exactly its documents
//  — is posted without a person, but only from a mail the receiving
//  server confirms really came from that sender (DKIM pass) and from an
//  allowed sender, or from the bank's SFTP server (its host key pinned):
//  a forged statement can suggest, never post.
//
//  THE SAME, BY SFTP (MT940)
//
//  A bank's cash-management desk can instead drop each day's statement
//  as MT940 (or CSV) on an SFTP server. The same run reads that folder:
//
//    BANK_SFTP_HOST          e.g. sftp.kotak.com
//    BANK_SFTP_PORT          22 (default)
//    BANK_SFTP_USER          the login the bank gave
//    BANK_SFTP_PASS          its password, or
//    BANK_SFTP_KEY           the path to a private key file (and
//    BANK_SFTP_KEY_PASSPHRASE if it has one)
//    BANK_SFTP_HOST_KEY      the server's key fingerprint, SHA256:…  —
//                            required: without it nothing is read, and
//                            the run reports the key the server offered,
//                            to be checked with the bank and set here
//    BANK_SFTP_DIR           the folder to read (default "/")
//    BANK_SFTP_DONE_DIR      optional: move a file here once it is read
//
//  Each file is read once (path, size and time recorded). An MT940 file
//  names its own account (:25:), so a file holding several accounts is
//  split between them; a CSV/Excel file is placed like a mail.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const BankAccount = require('../models/BankAccount');
const BankStatement = require('../models/BankStatement');
const BankFeedMessage = require('../models/BankFeedMessage');
const AccountsSettings = require('../models/AccountsSettings');
const { getSettings } = require('./booksLock');
const { importStatement } = require('./statementImport');

const DAY = 86_400_000;
const SHEET = /\.(csv|xlsx|xls)$/i;
const SFTP_FILE = /\.(sta|mt940|940|txt|csv|xlsx|xls)$/i;
const SHEET_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);

function config() {
  const e = process.env;
  return {
    host: e.BANK_FEED_IMAP_HOST || '', port: Number(e.BANK_FEED_IMAP_PORT || 993), secure: e.BANK_FEED_IMAP_SECURE !== 'false',
    user: e.BANK_FEED_IMAP_USER || '', pass: e.BANK_FEED_IMAP_PASS || '', mailbox: e.BANK_FEED_MAILBOX || 'INBOX',
    senders: String(e.BANK_FEED_SENDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    everyMin: e.BANK_FEED_EVERY_MIN === undefined ? 15 : Number(e.BANK_FEED_EVERY_MIN),
    days: 10, maxPerRun: 30,
    sftp: {
      host: e.BANK_SFTP_HOST || '', port: Number(e.BANK_SFTP_PORT || 22), user: e.BANK_SFTP_USER || '',
      pass: e.BANK_SFTP_PASS || '', keyPath: e.BANK_SFTP_KEY || '', passphrase: e.BANK_SFTP_KEY_PASSPHRASE || '',
      hostKey: String(e.BANK_SFTP_HOST_KEY || '').trim(), dir: e.BANK_SFTP_DIR || '/', doneDir: e.BANK_SFTP_DONE_DIR || '',
    },
  };
}
const mailOn = (c = config()) => !!(c.host && c.user && c.pass);
const sftpOn = (c = config()) => !!(c.sftp.host && c.sftp.user && (c.sftp.pass || c.sftp.keyPath));
const configured = (c = config()) => mailOn(c) || sftpOn(c);

// ── Reading the mailbox ────────────────────────────────────────────
/** Default reader: IMAP. Returns [{ messageId, source(Buffer) }] for mail not seen before. */
async function imapFetch(c, { since, isKnown }) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  const out = [];
  try {
    const lock = await client.getMailboxLock(c.mailbox);
    try {
      const uids = await client.search({ since }, { uid: true });
      const fresh = [];
      for await (const m of client.fetch(uids.slice(-200), { envelope: true }, { uid: true })) {
        const id = m.envelope?.messageId || `uid-${m.uid}`;
        if (!(await isKnown(id))) fresh.push(m.uid);
      }
      for (const uid of fresh.slice(0, c.maxPerRun)) {
        const m = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (m?.source) out.push({ messageId: m.envelope?.messageId || `uid-${uid}`, source: m.source });
      }
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}
let fetcher = imapFetch;
/** Tests replace the mailbox with a list of raw messages. */
function setFetcher(fn) { fetcher = fn || imapFetch; }

// ── Reading the SFTP folder ────────────────────────────────────────
/** OpenSSH's form of a host key's fingerprint: SHA256:<base64, unpadded>. */
const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
const samePrint = (a, b) => !!a && !!b && a.replace(/^SHA256:/i, '') === b.replace(/^SHA256:/i, '');

/**
 * Default SFTP reader. Calls onFile({ id, name, buffer, modifiedAt }) for
 * each statement file not seen before, oldest first, and moves it to the
 * done folder when onFile says it was read.
 */
async function sftpRead(s, { isKnown, onFile, maxPerRun }) {
  const Client = require('ssh2-sftp-client');
  const sftp = new Client('bank-feed');
  let offered = '';
  const opts = {
    host: s.host, port: s.port, username: s.user, readyTimeout: 20_000,
    hostVerifier: (key) => { offered = fingerprint(key); return samePrint(offered, s.hostKey); },
  };
  if (s.keyPath) { opts.privateKey = require('fs').readFileSync(s.keyPath); if (s.passphrase) opts.passphrase = s.passphrase; } else opts.password = s.pass;
  try {
    await sftp.connect(opts);
  } catch (err) {
    if (offered && !samePrint(offered, s.hostKey)) {
      throw new Error(s.hostKey
        ? `The SFTP server's key is ${offered}, not the one set in BANK_SFTP_HOST_KEY — nothing was read. Check with the bank before changing it.`
        : `The SFTP server offered the key ${offered}. Check it with the bank, then set BANK_SFTP_HOST_KEY to it — nothing is read until then.`);
    }
    throw err;
  }
  try {
    const dir = s.dir.replace(/\/+$/, '') || '/';
    const entries = (await sftp.list(dir)).filter((f) => f.type === '-' && SFTP_FILE.test(f.name)).sort((a, b) => a.modifyTime - b.modifyTime);
    let done = 0;
    for (const f of entries) {
      if (done >= maxPerRun) break;
      const path = `${dir === '/' ? '' : dir}/${f.name}`;
      const id = `sftp:${path}:${f.size}:${f.modifyTime}`;
      if (await isKnown(id)) continue;
      const buffer = await sftp.get(path);
      done += 1;
      const r = await onFile({ id, name: f.name, buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), modifiedAt: new Date(f.modifyTime) });
      if (s.doneDir && (r.status === 'imported' || r.status === 'nothing_new')) {
        await sftp.rename(path, `${s.doneDir.replace(/\/+$/, '')}/${f.name}`).catch((err) => console.error('[bank-feed] could not move', f.name, err.message));
      }
    }
  } finally {
    await sftp.end().catch(() => {});
  }
}
let sftpReader = sftpRead;
/** Tests replace the SFTP server with a function that calls onFile. */
function setSftpReader(fn) { sftpReader = fn || sftpRead; }

// ── One message ────────────────────────────────────────────────────
const senderOk = (from, allowed) => !allowed.length || allowed.some((a) => (a.startsWith('@') ? from.endsWith(a) : from === a));

/** Did the receiving server see a passing DKIM signature from the sender's own domain? */
function dkimPass(headers, from) {
  const domain = from.split('@')[1] || '';
  const ar = [].concat(headers.get('authentication-results') || []).map(String).join(' ').toLowerCase();
  return !!domain && new RegExp(`dkim=pass[^;]*header\\.(?:d|i)=@?([a-z0-9.-]*\\.)?${domain.replace(/\./g, '\\.')}`).test(ar);
}

/** Which bank account a mail is for: its number in the mail, its statement address, or the only one. */
function accountFor(accounts, { from, subject, text, filenames }) {
  const hay = `${subject} ${filenames.join(' ')} ${text}`.replace(/\s+/g, ' ');
  const num = (a) => String(a.accountNo || '').replace(/\D/g, '');
  // The whole number, or its last four shown the way banks mask it
  // (XXXXXX9219, **9219, "A/c ending 9219") — never a bare four digits,
  // which a year or an amount could be.
  const full = accounts.filter((a) => num(a).length >= 6 && hay.replace(/[\s-]/g, '').includes(num(a)));
  const masked = accounts.filter((a) => {
    const n = num(a);
    if (n.length < 4) return false;
    const last4 = n.slice(-4);
    return new RegExp(`(?:[X*x]{2,}[\\d]*${last4}|(?:a\\/?c|acct|account)(?:\\s*(?:no\\.?|number|ending|with|in))*[\\s:.#-]*[X*x\\d]*${last4})(?!\\d)`, 'i').test(hay);
  });
  const byNumber = full.length ? full : masked;
  if (byNumber.length === 1) return { account: byNumber[0], by: 'account number' };
  const bySender = accounts.filter((a) => a.statementFrom && a.statementFrom === from);
  if (bySender.length === 1) return { account: bySender[0], by: 'sender' };
  if (accounts.length === 1) return { account: accounts[0], by: 'only bank account' };
  return { account: null, why: byNumber.length > 1 ? 'the mail names more than one of our accounts' : 'no account number in the mail, and no account set to this sender' };
}

/**
 * Lines the matcher is sure of, posted as vouchers: documents named in
 * the narration that themselves add up to the amount (`exact`). Each
 * goes through the same door as a line a person posts
 * (services/statementPosting.js), so a line is posted once whoever
 * reaches it first.
 */
async function autoPost(statement, account, via = 'email') {
  const { postRow } = require('./statementPosting');
  const req = { user: { _id: null, name: `Bank statement (${via === 'sftp' ? 'SFTP' : 'email'})`, role: 'accounts' }, body: {} };
  let posted = 0;
  const doc = await BankStatement.findById(statement._id).lean();
  for (const l of doc.lines) {
    const s = l.suggestion;
    if (l.status !== 'matched' || !s || !s.exact || s.confidence < 0.95 || s.partyType === 'other' || !s.party) continue;
    const allocated = Math.round((s.allocations || []).reduce((t, a) => t + (a.amount || 0), 0) * 100) / 100;
    if (!s.allocations?.length || Math.abs(allocated - l.amount) > 0.005) continue;
    try {
      const out = await postRow({
        accountId: account._id, statement: doc, req,
        row: { index: l.index, partyType: s.partyType, party: s.party, mode: 'bank', allocations: s.allocations.map((a) => ({ docType: a.docType, doc: a.doc, amount: a.amount })) },
        note: via === 'sftp' ? 'Posted from the bank\'s SFTP statement' : 'Posted from the emailed statement',
      });
      if (out.ok && !out.replay) posted += 1;
    } catch (err) {
      await BankStatement.updateOne({ _id: doc._id, 'lines.index': l.index }, { $set: { 'lines.$.note': `Not posted automatically: ${err.message}`.slice(0, 200) } });
    }
  }
  return posted;
}

async function handle(raw, { c, accounts, settings }) {
  const { simpleParser } = require('mailparser');
  const mail = await simpleParser(raw.source);
  const messageId = mail.messageId || raw.messageId || `sha-${crypto.createHash('sha256').update(raw.source).digest('hex').slice(0, 32)}`;
  const from = String(mail.from?.value?.[0]?.address || '').toLowerCase();
  const subject = String(mail.subject || '').slice(0, 300);
  const base = { messageId, from, subject, receivedAt: mail.date || new Date() };
  // Claim the message first: a second process sees the duplicate and leaves it.
  try { await BankFeedMessage.create({ ...base, status: 'skipped', note: 'reading' }); } catch (err) {
    if (err?.code === 11000) return { status: 'known' };
    throw err;
  }
  const finish = async (status, extra = {}) => { await BankFeedMessage.updateOne({ messageId }, { $set: { status, note: '', ...extra } }); return { status, ...extra }; };

  const allowed = [...c.senders, ...accounts.map((a) => a.statementFrom).filter(Boolean)];
  if (!senderOk(from, allowed)) return finish('skipped', { note: `${from || 'Unknown sender'} is not an allowed statement sender` });
  const sheets = (mail.attachments || []).filter((a) => SHEET.test(a.filename || '') || SHEET_TYPES.has(a.contentType));
  if (!sheets.length) {
    const pdf = (mail.attachments || []).some((a) => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename || ''));
    return finish('skipped', { note: pdf ? 'A PDF statement cannot be read — set the bank\'s scheduled statement to CSV or Excel' : 'No CSV or Excel statement attached' });
  }
  const placed = accountFor(accounts, { from, subject, text: String(mail.text || '').slice(0, 5000), filenames: sheets.map((a) => a.filename || '') });
  if (!placed.account) return finish('failed', { note: `Could not tell which bank account: ${placed.why}. Set "Statements come from" on the account, or include the account number in the statement name.` });
  const account = placed.account;
  const trusted = c.senders.length > 0 && senderOk(from, c.senders) && dkimPass(mail.headers, from);
  let lines = 0; let newLines = 0; let posted = 0; const statements = [];
  try {
    for (const a of sheets) {
      const out = await importStatement({ account, buffer: a.content, mimetype: a.contentType, filename: a.filename || 'statement', byName: 'Bank statement (email)', source: 'email', messageId });
      lines += out.total; newLines += out.newLines;
      if (out.statement) {
        statements.push(out.statement._id);
        if (settings.bankFeed?.autoPost && trusted) posted += await autoPost(out.statement, account);
      }
    }
  } catch (err) {
    return finish('failed', { account: account._id, accountName: account.name, statements, note: `Could not read the statement: ${err.message}`.slice(0, 300) });
  }
  return finish(newLines ? 'imported' : 'nothing_new', {
    account: account._id, accountName: account.name, statements, lines, newLines, posted,
    note: `${account.name}, by ${placed.by}${settings.bankFeed?.autoPost && !trusted ? ' · not posted automatically: the sender is not on the allowed list or its signature did not check' : ''}`,
  });
}

// ── One SFTP file ──────────────────────────────────────────────────
const digits = (v) => String(v || '').replace(/\D/g, '');
/** The bank account an MT940 :25: number is: whole number, or the last digits of a shortened one. */
function accountByNumber(accounts, no) {
  const n = digits(no);
  if (n.length < 4) return null;
  const hits = accounts.filter((a) => {
    const mine = digits(a.accountNo);
    if (mine.length < 4) return false;
    const k = Math.min(mine.length, n.length);
    return mine.slice(-k) === n.slice(-k);
  });
  return hits.length === 1 ? hits[0] : null;
}

async function handleFile(file, { c, accounts, settings }) {
  const { isMt940, parseMt940 } = require('./mt940');
  const base = { messageId: file.id, channel: 'sftp', from: `sftp://${c.sftp.host}`, subject: file.name, receivedAt: file.modifiedAt || new Date() };
  try { await BankFeedMessage.create({ ...base, status: 'skipped', note: 'reading' }); } catch (err) {
    if (err?.code === 11000) return { status: 'known' };
    throw err;
  }
  const finish = async (status, extra = {}) => { await BankFeedMessage.updateOne({ messageId: file.id }, { $set: { status, note: '', ...extra } }); return { status, ...extra }; };
  const auto = !!settings.bankFeed?.autoPost; // the host key is pinned: the file is the bank's
  // What goes in: [{ account, rows?, buffer? }]
  const parts = [];
  const text = /\.xlsx?$/i.test(file.name) ? '' : file.buffer.toString('utf8');
  if (text && isMt940(text)) {
    const byAccount = new Map();
    for (const st of parseMt940(text)) {
      const key = st.account || '';
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(...st.rows);
    }
    for (const [no, rows] of byAccount) {
      const account = no ? accountByNumber(accounts, no) : (accounts.length === 1 ? accounts[0] : null);
      if (!account) return finish('failed', { note: no ? `The statement is for account ${no}; no bank account here has that number. Add it under Settings → Accounts.` : 'The statement names no account, and there is more than one bank account here.' });
      parts.push({ account, rows, accountNo: no });
    }
  } else {
    const placed = accountFor(accounts, { from: '', subject: file.name, text: '', filenames: [file.name] });
    if (!placed.account) return finish('failed', { note: `Could not tell which bank account: ${placed.why}. Put the account number in the file name the bank uses.` });
    parts.push({ account: placed.account, buffer: file.buffer });
  }
  let lines = 0; let newLines = 0; let posted = 0; const statements = [];
  try {
    for (const p of parts) {
      const out = await importStatement({
        account: p.account, rows: p.rows || null, accountNo: p.accountNo || '', buffer: p.buffer, filename: file.name,
        mimetype: /\.xlsx?$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain',
        byName: 'Bank statement (SFTP)', source: 'sftp', messageId: file.id,
      });
      lines += out.total; newLines += out.newLines;
      if (out.statement) {
        statements.push(out.statement._id);
        if (auto) posted += await autoPost(out.statement, p.account, 'sftp');
      }
    }
  } catch (err) {
    return finish('failed', { account: parts[0]?.account._id || null, accountName: parts.map((p) => p.account.name).join(', '), statements, note: `Could not read the statement: ${err.message}`.slice(0, 300) });
  }
  const names = [...new Set(parts.map((p) => p.account.name))];
  return finish(newLines ? 'imported' : 'nothing_new', { account: parts[0].account._id, accountName: names.join(', '), statements, lines, newLines, posted, note: names.join(', ') });
}

// ── A run ──────────────────────────────────────────────────────────
/**
 * Read the mailbox once. Only one process runs at a time (a lease on
 * the settings document); the others return { busy: true }.
 */
async function run({ trigger = 'timer' } = {}) {
  const c = config();
  if (!configured(c)) return { configured: false };
  await getSettings();
  const now = new Date();
  const lease = await AccountsSettings.findOneAndUpdate(
    { key: 'accounts', $or: [{ 'bankFeed.lockUntil': null }, { 'bankFeed.lockUntil': { $exists: false } }, { 'bankFeed.lockUntil': { $lt: now } }] },
    { $set: { 'bankFeed.lockUntil': new Date(now.getTime() + 5 * 60_000) } },
    { new: true }
  ).lean();
  if (!lease) return { configured: true, busy: true };
  const result = { configured: true, trigger, at: now, checked: 0, imported: 0, nothingNew: 0, skipped: 0, failed: 0, newLines: 0, posted: 0, error: null };
  const count = (r) => {
    if (r.status === 'known') return;
    result.checked += 1;
    if (r.status === 'imported') result.imported += 1;
    else if (r.status === 'nothing_new') result.nothingNew += 1;
    else if (r.status === 'skipped') result.skipped += 1;
    else result.failed += 1;
    result.newLines += r.newLines || 0;
    result.posted += r.posted || 0;
  };
  const isKnown = async (id) => !!(await BankFeedMessage.exists({ messageId: id }));
  const errors = [];
  try {
    const accounts = await BankAccount.find({ active: { $ne: false }, kind: 'bank' }).lean();
    // Each channel on its own: a mailbox that is down does not stop the SFTP read.
    if (mailOn(c)) {
      try {
        const messages = await fetcher(c, { since: new Date(now.getTime() - c.days * DAY), isKnown });
        for (const m of messages) count(await handle(m, { c, accounts, settings: lease }));
      } catch (err) { errors.push(`Mailbox: ${err.message}`); }
    }
    if (sftpOn(c)) {
      try {
        // Without BANK_SFTP_HOST_KEY the reader connects only far enough to
        // see the server's key, refuses it, and reports it to be checked.
        await sftpReader(c.sftp, { isKnown, maxPerRun: c.maxPerRun, onFile: async (f) => { const r = await handleFile(f, { c, accounts, settings: lease }); count(r); return r; } });
      } catch (err) { errors.push(`SFTP: ${err.message}`); }
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    result.error = errors.length ? errors.join(' · ') : null;
    await AccountsSettings.updateOne({ key: 'accounts' }, { $set: { 'bankFeed.lockUntil': null, 'bankFeed.lastRunAt': new Date(), 'bankFeed.lastResult': result } });
  }
  return result;
}

let timer = null;
/** The timer, in every process; the lease keeps them from overlapping. */
function start() {
  const c = config();
  if (timer || !configured(c) || !(c.everyMin > 0)) return null;
  timer = setInterval(() => { run().catch((err) => console.error('[bank-feed] run failed:', err?.message)); }, c.everyMin * 60_000);
  timer.unref?.();
  console.log(`[bank-feed] reading ${[mailOn(c) && c.user, sftpOn(c) && `sftp://${c.sftp.host}`].filter(Boolean).join(' and ')} every ${c.everyMin} min`);
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

/** What the screen shows: is it set up, when it last ran, the last mails. */
async function status() {
  const c = config();
  const s = await getSettings();
  const recent = await BankFeedMessage.find({}).sort({ createdAt: -1 }).limit(20).lean();
  return {
    configured: configured(c), mailbox: mailOn(c) ? c.user : '', everyMin: c.everyMin, senders: c.senders,
    sftp: sftpOn(c) ? { host: c.sftp.host, dir: c.sftp.dir, hostKeySet: !!c.sftp.hostKey } : null,
    autoPost: !!s.bankFeed?.autoPost, lastRunAt: s.bankFeed?.lastRunAt || null, lastResult: s.bankFeed?.lastResult || null,
    recent: recent.map((m) => ({ _id: m._id, from: m.from, subject: m.subject, receivedAt: m.receivedAt, channel: m.channel || 'email', status: m.status, accountName: m.accountName, newLines: m.newLines, lines: m.lines, posted: m.posted, note: m.note, statement: m.statements?.[0] || null, account: m.account })),
  };
}

module.exports = { run, start, stop, status, config, configured, setFetcher, setSftpReader, accountFor, accountByNumber, dkimPass, senderOk, handle, handleFile, fingerprint, samePrint };
