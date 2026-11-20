'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BANK'S STATEMENTS, FROM A MAILBOX — WITHOUT A MAILBOX
//
//    • a mailed CSV lands in the bank account named in the mail, its
//      lines matched and kept with what the matcher proposed
//    • a mail is read once, however often the mailbox is checked
//    • overlapping daily statements add only the lines not seen before
//    • a sender not allowed, a PDF, an account that cannot be told —
//      each recorded with the reason, nothing imported
//    • posting without a person only for a sure match from a mail whose
//      signature checks; a forged one can suggest, never post
//    • the screen's routes, and the scheduler's door
//
//  The IMAP reader is replaced by a list of raw messages: these pin what
//  is done with a mail, not how the mailbox is reached.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const MailComposer = require('nodemailer/lib/mail-composer');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

let mongo, app, M, admin, feed;
let inbox = [];
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

const csv = (lines) => Buffer.from(['Txn Date,Narration,Ref No,Withdrawal,Deposit,Balance', ...lines].join('\n'));
async function mail({ id, from = 'statements@kotak.com', subject = 'Statement for A/c XXXXXX9219', attachments = [], dkim = false }) {
  const raw = await new MailComposer({
    from, to: 'statements@baluelastics.com', subject, text: 'Please find your statement attached.', messageId: `<${id}@kotak.com>`,
    headers: dkim ? { 'Authentication-Results': `mx1.hostinger.com; dkim=pass header.d=${from.split('@')[1]} header.s=s1; spf=pass` } : {},
    attachments,
  }).compile().build();
  return { messageId: `<${id}@kotak.com>`, source: raw };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  feed = require('../../services/bankFeed');
  feed.setFetcher(async (_c, { isKnown }) => { const out = []; for (const m of inbox) if (!(await isKnown(m.messageId))) out.push(m); return out; });
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'Payment', 'BankAccount', 'BankStatement', 'BankFeedMessage', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'feed@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { feed.setFetcher(null); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  inbox = [];
  Object.assign(process.env, { BANK_FEED_IMAP_HOST: 'imap.test', BANK_FEED_IMAP_USER: 'statements@baluelastics.com', BANK_FEED_IMAP_PASS: 'x', BANK_FEED_SENDERS: '@kotak.com', BANK_FEED_EVERY_MIN: '0' });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function scene() {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise Garments ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, phoneNumber: '9200000000' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(700 + n).padStart(4, '0')}`, financialYear: '2026-27', sequence: 700 + n, invoiceDate: new Date('2026-10-20'), dueDate: new Date('2026-11-19'),
    order: new mongoose.Types.ObjectId(), customer: customer._id, buyer: { name: customer.name }, supplyType: 'intra', lines: [], totals: { taxable: 10000, grand: 10500 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 10500 });
  const kotak = await M.BankAccount.create({ name: 'Kotak CA', kind: 'bank', accountNo: '7612149219', openingBalance: 100000 });
  return { customer, inv, kotak };
}

describe('statements by email', () => {
  it('imports a mailed CSV into the account it names, keeps what was proposed, and reads a mail once', async () => {
    const s = await scene();
    await M.BankAccount.create({ name: 'ICICI CA', kind: 'bank', accountNo: '000405012026' });
    inbox.push(await mail({ id: 'm1', attachments: [{ filename: 'OpTransactionHistory.csv', content: csv([`02/11/2026,NEFT SUNRISE GARMENTS ${s.inv.invoiceNumber},UTR1,,10500,110500`, '02/11/2026,BANK CHARGES,,59,,110441']), contentType: 'text/csv' }] }));
    const r = await feed.run();
    expect(r).toMatchObject({ checked: 1, imported: 1, newLines: 2 });
    const st = await M.BankStatement.findOne({}).lean();
    expect(st).toMatchObject({ source: 'email', accountName: 'Kotak CA', messageId: '<m1@kotak.com>', uploadedByName: 'Bank statement (email)' });
    const line = st.lines.find((l) => l.direction === 'in');
    expect(line).toMatchObject({ status: 'matched', suggestion: expect.objectContaining({ party: s.customer._id, allocations: [expect.objectContaining({ docNo: s.inv.invoiceNumber, amount: 10500 })] }) });
    // The inbox counts them, and its link opens this statement.
    const ib = (await get('/accounts/inbox')).body.bankLines;
    expect(ib).toMatchObject({ count: 2, statement: String(st._id) });
    // Stored suggestions come back with the statement, ready to post.
    const stored = (await get(`/accounts/bank/statements/${st._id}`)).body.statement;
    expect(stored.lines.find((l) => l.direction === 'in').suggestion.allocations[0].docNo).toBe(s.inv.invoiceNumber);
    // Read once.
    expect(await feed.run()).toMatchObject({ checked: 0 });
    expect(await M.BankStatement.countDocuments({})).toBe(1);
    // Tomorrow's statement repeats yesterday's lines: only the new one is kept.
    inbox.push(await mail({ id: 'm2', attachments: [{ filename: 'OpTransactionHistory.csv', content: csv([`02/11/2026,NEFT SUNRISE GARMENTS ${s.inv.invoiceNumber},UTR1,,10500,110500`, '02/11/2026,BANK CHARGES,,59,,110441', '03/11/2026,CASH WDL SELF,,5000,,105441']), contentType: 'text/csv' }] }));
    expect(await feed.run()).toMatchObject({ checked: 1, imported: 1, newLines: 1 });
    // And one with nothing new is noted, not kept.
    inbox.push(await mail({ id: 'm3', attachments: [{ filename: 's.csv', content: csv(['03/11/2026,CASH WDL SELF,,5000,,105441']), contentType: 'text/csv' }] }));
    expect(await feed.run()).toMatchObject({ checked: 1, nothingNew: 1 });
    expect(await M.BankStatement.countDocuments({})).toBe(2);
  });

  it('records why a mail was not imported: sender, PDF, or which account', async () => {
    await scene();
    await M.BankAccount.create({ name: 'ICICI CA', kind: 'bank', accountNo: '000405012026' });
    inbox.push(await mail({ id: 'spoof', from: 'statements@kotak-alerts.example', attachments: [{ filename: 'a.csv', content: csv(['02/11/2026,X,,1,,1']), contentType: 'text/csv' }] }));
    inbox.push(await mail({ id: 'pdf', attachments: [{ filename: 'statement.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }] }));
    inbox.push(await mail({ id: 'which', subject: 'Your statement', attachments: [{ filename: 'a.csv', content: csv(['02/11/2026,X,,1,,1']), contentType: 'text/csv' }] }));
    const r = await feed.run();
    expect(r).toMatchObject({ checked: 3, skipped: 2, failed: 1, imported: 0 });
    const notes = Object.fromEntries((await M.BankFeedMessage.find({}).lean()).map((m) => [m.messageId, m.note]));
    expect(notes['<spoof@kotak.com>']).toMatch(/not an allowed statement sender/);
    expect(notes['<pdf@kotak.com>']).toMatch(/PDF statement cannot be read/);
    expect(notes['<which@kotak.com>']).toMatch(/Could not tell which bank account/);
    expect(await M.BankStatement.countDocuments({})).toBe(0);
  });

  it('posts a sure match without a person only from a mail whose signature checks', async () => {
    const s = await scene();
    expect((await put('/accounts/bank/feed', { autoPost: true })).body.feed).toMatchObject({ autoPost: true });
    const line = `02/11/2026,NEFT SUNRISE GARMENTS ${s.inv.invoiceNumber},UTR9,,10500,110500`;
    inbox.push(await mail({ id: 'unsigned', attachments: [{ filename: 'a.csv', content: csv([line]), contentType: 'text/csv' }] }));
    expect(await feed.run()).toMatchObject({ imported: 1, posted: 0 });
    expect(await M.Payment.countDocuments({})).toBe(0);
    await M.BankStatement.deleteMany({});
    inbox.push(await mail({ id: 'signed', dkim: true, attachments: [{ filename: 'b.csv', content: csv([line]), contentType: 'text/csv' }] }));
    expect(await feed.run()).toMatchObject({ imported: 1, posted: 1 });
    const v = await M.Payment.findOne({}).lean();
    expect(v).toMatchObject({ kind: 'receipt', amount: 10500, status: 'posted', allocations: [expect.objectContaining({ docNo: s.inv.invoiceNumber })] });
    expect((await M.Invoice.findById(s.inv._id).lean()).paidAmount).toBe(10500);
    const st = await M.BankStatement.findOne({ messageId: '<signed@kotak.com>' }).lean();
    expect(st.lines[0]).toMatchObject({ status: 'posted', voucherNo: v.voucherNo });
  });

  it('answers the screen and the scheduler', async () => {
    await scene();
    let st = (await get('/accounts/bank/feed')).body.feed;
    expect(st).toMatchObject({ configured: true, mailbox: 'statements@baluelastics.com', autoPost: false, senders: ['@kotak.com'], authServer: '' });
    process.env.BANK_FEED_AUTHSERV = ' MX1.Hostinger.com ';
    expect((await get('/accounts/bank/feed')).body.feed.authServer).toBe('mx1.hostinger.com');
    delete process.env.BANK_FEED_AUTHSERV;
    inbox.push(await mail({ id: 'now', attachments: [{ filename: 'a.csv', content: csv(['02/11/2026,CASH WDL SELF,,5000,,95000']), contentType: 'text/csv' }] }));
    const r = await post('/accounts/bank/feed/run', {});
    expect(r.body.result).toMatchObject({ trigger: 'manual', imported: 1 });
    st = r.body.feed;
    expect(st.recent[0]).toMatchObject({ status: 'imported', accountName: 'Kotak CA', newLines: 1 });
    expect(st.lastResult).toMatchObject({ imported: 1 });
    process.env.CRON_SECRET = 'cron-test';
    expect((await request(app).post('/api/v2/notify/cron/bank-feed').set('x-cron-secret', 'wrong')).status).toBe(401);
    expect((await request(app).post('/api/v2/notify/cron/bank-feed').set('x-cron-secret', 'cron-test')).body).toMatchObject({ success: true, trigger: 'cron', checked: 0 });
    delete process.env.CRON_SECRET;
    delete process.env.BANK_FEED_IMAP_HOST;
    expect((await post('/accounts/bank/feed/run', {})).status).toBe(409);
    expect((await get('/accounts/bank/feed')).body.feed.configured).toBe(false);
  });
});

describe('a forged statement can suggest, never post', () => {
  const h = (v) => new Map([['authentication-results', v]]);
  afterEach(() => { delete process.env.BANK_FEED_AUTHSERV; });

  it('takes the receiving server\'s word only: its header is on top, one further down is the sender\'s own writing', () => {
    const ours = 'mx1.hostinger.com; dkim=fail header.d=kotak.com; spf=fail smtp.mailfrom=evil.example';
    const written = 'mx1.hostinger.com; dkim=pass header.d=kotak.com header.s=s1';
    expect(feed.dkimPass(h([ours, written]), 'statements@kotak.com')).toBe(false);
    expect(feed.dkimPass(h(['mx1.hostinger.com; dkim=none', written]), 'statements@kotak.com')).toBe(false);
    // The same two the other way up: the server said pass.
    expect(feed.dkimPass(h([written, ours]), 'statements@kotak.com')).toBe(true);
  });

  it('a signing domain that only begins with the bank\'s is not the bank', () => {
    const from = 'statements@kotak.com';
    expect(feed.dkimPass(h('mx; dkim=pass header.d=kotak.com.evil.org header.s=s1'), from)).toBe(false);
    expect(feed.dkimPass(h('mx; dkim=pass header.d=kotak.community'), from)).toBe(false);
    expect(feed.dkimPass(h('mx; dkim=pass header.i=@kotak.com.evil.org'), from)).toBe(false);
    expect(feed.dkimPass(h('mx; dkim=pass header.d=evil-kotak.com'), from)).toBe(false);
    // The bank's own, however the server writes it.
    expect(feed.dkimPass(h('mx; dkim=pass header.d=kotak.com; spf=pass'), from)).toBe(true);
    expect(feed.dkimPass(h('mx; dkim=pass (signature was verified) header.d=kotak.com;dmarc=pass'), from)).toBe(true);
    expect(feed.dkimPass(h('mx; dkim=pass header.i=@kotak.com header.s=s1 header.b=abc'), from)).toBe(true);
    expect(feed.dkimPass(h('mx; dkim=pass header.d=mail.kotak.com'), from)).toBe(true);
    expect(feed.dkimPass(h('MX; DKIM=PASS header.d=KOTAK.COM'), 'Statements@Kotak.com')).toBe(true);
  });

  it('with the mail host named, only that host\'s header counts', () => {
    process.env.BANK_FEED_AUTHSERV = 'mx1.hostinger.com';
    const from = 'statements@kotak.com';
    // An inner hop wrote its own on top: the named host's is still the one read.
    expect(feed.dkimPass(h(['inner.hostinger.internal; none', 'mx1.hostinger.com; dkim=pass header.d=kotak.com']), from)).toBe(true);
    // A mail host that writes none leaves only the sender's: not read at all.
    expect(feed.dkimPass(h('mx.evil.example; dkim=pass header.d=kotak.com'), from)).toBe(false);
    // Its own header first, a copy of its name further down: the first is the server's.
    expect(feed.dkimPass(h(['mx1.hostinger.com; dkim=fail header.d=kotak.com', 'mx1.hostinger.com; dkim=pass header.d=kotak.com']), from)).toBe(false);
  });

  it('a mail carrying its own "signature checked" line under the server\'s "it did not" posts nothing', async () => {
    const s = await scene();
    await put('/accounts/bank/feed', { autoPost: true });
    const line = `02/11/2026,NEFT SUNRISE GARMENTS ${s.inv.invoiceNumber},UTR9,,10500,110500`;
    const forged = await mail({ id: 'forged', dkim: true, attachments: [{ filename: 'a.csv', content: csv([line]), contentType: 'text/csv' }] });
    // What the receiving server adds on arrival goes above everything the mail came with.
    forged.source = Buffer.concat([Buffer.from('Authentication-Results: mx1.hostinger.com; dkim=none; spf=fail smtp.mailfrom=evil.example\r\n'), forged.source]);
    inbox.push(forged);
    expect(await feed.run()).toMatchObject({ imported: 1, posted: 0 });
    expect(await M.Payment.countDocuments({})).toBe(0);
    expect((await M.Invoice.findById(s.inv._id).lean()).paidAmount || 0).toBe(0);
    // It still came in, for a person to look at.
    const st = await M.BankStatement.findOne({ messageId: '<forged@kotak.com>' }).lean();
    expect(st.lines[0]).toMatchObject({ status: 'matched' });
    expect((await M.BankFeedMessage.findOne({ messageId: '<forged@kotak.com>' }).lean()).note).toMatch(/not posted automatically/);
  });
});

describe('a statement that failed is read again when a person asks', () => {
  it('the timer leaves it; "check now" reads it once what its note said is put right', async () => {
    const s = await scene();
    const icici = await M.BankAccount.create({ name: 'ICICI CA', kind: 'bank', accountNo: '000405012026' });
    inbox.push(await mail({ id: 'which', subject: 'Your statement', attachments: [{ filename: 'a.csv', content: csv(['02/11/2026,CASH WDL SELF,,5000,,95000']), contentType: 'text/csv' }] }));
    expect(await feed.run()).toMatchObject({ checked: 1, failed: 1 });
    const failed = await M.BankFeedMessage.findOne({ messageId: '<which@kotak.com>' }).lean();
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.note).toMatch(/Could not tell which bank account/);
    expect(failed.note).toMatch(/check the mailbox again/i);

    // The account is told where its statements come from.
    await M.BankAccount.updateOne({ _id: s.kotak._id }, { $set: { statementFrom: 'statements@kotak.com' } });
    // The timer does not fetch a failed one every few minutes…
    expect(await feed.run()).toMatchObject({ checked: 0 });
    expect(await M.BankStatement.countDocuments({})).toBe(0);
    // …a person's check does.
    const r = await post('/accounts/bank/feed/run', {});
    expect(r.body.result).toMatchObject({ trigger: 'manual', checked: 1, imported: 1, newLines: 1 });
    const now = await M.BankFeedMessage.find({ messageId: '<which@kotak.com>' }).lean();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ status: 'imported', accountName: 'Kotak CA', newLines: 1 });
    expect(String(now[0]._id)).toBe(String(failed._id));
    expect(await M.BankStatement.countDocuments({ account: s.kotak._id })).toBe(1);
    expect(await M.BankStatement.countDocuments({ account: icici._id })).toBe(0);
    // Read: asking again does not read it a second time.
    expect((await post('/accounts/bank/feed/run', {})).body.result).toMatchObject({ checked: 0 });
    expect(await M.BankStatement.countDocuments({})).toBe(1);
  });

  it('one left half-read by a server that stopped is picked up too, but not while another may still be reading it', async () => {
    await scene();
    const m = await mail({ id: 'half', attachments: [{ filename: 'a.csv', content: csv(['02/11/2026,CASH WDL SELF,,5000,,95000']), contentType: 'text/csv' }] });
    inbox.push(m);
    // Claimed a moment ago: someone is on it.
    await M.BankFeedMessage.create({ messageId: m.messageId, status: 'skipped', note: 'reading' });
    expect((await post('/accounts/bank/feed/run', {})).body.result).toMatchObject({ checked: 0 });
    // Claimed an hour ago and never finished.
    await M.BankFeedMessage.collection.updateOne({ messageId: m.messageId }, { $set: { updatedAt: new Date(Date.now() - 3_600_000) } });
    expect((await post('/accounts/bank/feed/run', {})).body.result).toMatchObject({ checked: 1, imported: 1 });
    // A mail set aside for a reason (sender, PDF) is not one of these.
    inbox.push(await mail({ id: 'pdf2', attachments: [{ filename: 'statement.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }] }));
    expect((await post('/accounts/bank/feed/run', {})).body.result).toMatchObject({ checked: 1, skipped: 1 });
    expect((await post('/accounts/bank/feed/run', {})).body.result).toMatchObject({ checked: 0 });
  });
});

describe('telling which account and whether a signature checks', () => {
  it('reads an account number only in full or masked, and DKIM only from the sender\'s domain', () => {
    const A = [{ name: 'Kotak', accountNo: '7612149219' }, { name: 'ICICI', accountNo: '000405012026' }];
    const which = (o) => feed.accountFor(A, { from: 'x@y', subject: '', text: '', filenames: [], ...o }).account?.name || null;
    expect(which({ subject: 'Statement for A/c XXXXXX9219' })).toBe('Kotak');
    expect(which({ text: 'Your a/c no. ending with 2026' })).toBe('ICICI');
    expect(which({ subject: 'Statement for October 2026' })).toBeNull();
    const h = (v) => new Map([['authentication-results', v]]);
    expect(feed.dkimPass(h('mx; dkim=pass header.d=kotak.com header.s=s1'), 'statements@kotak.com')).toBe(true);
    expect(feed.dkimPass(h('mx; dkim=pass header.d=evil.com'), 'statements@kotak.com')).toBe(false);
    expect(feed.dkimPass(h('mx; dkim=fail header.d=kotak.com'), 'statements@kotak.com')).toBe(false);
  });
});
