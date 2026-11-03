'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BANK'S STATEMENTS BY SFTP, IN MT940 — WITHOUT AN SFTP SERVER
//
//    • MT940 reads as the CSV does: dates, directions, reversals,
//      narration from :86:, the running balance from :62F:
//    • an MT940 upload lands only in the account its :25: names
//    • a file on the bank's server is read once, split between the
//      accounts it holds, overlapping days adding only new lines
//    • an account number we do not have is reported, nothing imported
//    • a sure match posts without a person (the host key is pinned)
//    • without a pinned host key nothing is read, and the key the
//      server offered is reported to be checked
//
//  The SFTP reader is replaced by a function that hands over files.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { parseMt940, isMt940, transactionOf } = require('../../services/mt940');

jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const MT = (account, day, lines, closing) => [
  '{1:F01KKBKINBBAXXX0000000000}{2:O9401200261001KKBKINBBAXXX00000000002610011200N}{4:',
  `:20:STMT${day}`,
  `:25:KKBKINBB/${account}`,
  ':28C:1/1',
  `:60F:C26${day}INR100000,00`,
  ...lines,
  `:62F:C26${day}INR${closing}`,
  '-}',
].join('\r\n');

describe('reading MT940', () => {
  const text = MT('7612149219', '1001', [
    ':61:2610011001C10500,00NTRFINV0701//KKBK000123',
    ':86:NEFT CR SUNRISE GARMENTS',
    'INV/2026-27/0701',
    ':61:2610011001D6300,NCHK000101//KKBK000124',
    ':86:CHQ 101 LANDLORD',
    ':61:2610011001RC250,00NMSCNONREF//KKBK000125',
    ':86:REVERSED CHARGES CREDIT',
  ], '103950,00');

  it('knows MT940 from a CSV', () => {
    expect(isMt940(text)).toBe(true);
    expect(isMt940('Txn Date,Narration,Withdrawal,Deposit\n01/10/2026,X,,10')).toBe(false);
  });

  it('reads dates, directions, references, narration and the running balance', () => {
    const [st] = parseMt940(text);
    expect(st.account).toBe('7612149219');
    expect(st.opening.amount).toBe(100000);
    expect(st.closing.amount).toBe(103950);
    expect(st.rows).toHaveLength(3);
    const [a, b, c] = st.rows;
    expect(a).toMatchObject({ direction: 'in', amount: 10500, ref: 'INV0701', narration: 'NEFT CR SUNRISE GARMENTS INV/2026-27/0701' });
    expect(a.date.getFullYear()).toBe(2026); expect(a.date.getMonth()).toBe(9); expect(a.date.getDate()).toBe(1);
    expect(b).toMatchObject({ direction: 'out', amount: 6300, ref: '000101', narration: 'CHQ 101 LANDLORD' });
    // A reversed credit takes money out; NONREF gives way to the bank's reference.
    expect(c).toMatchObject({ direction: 'out', amount: 250, ref: 'KKBK000125' });
    expect(c.narration).toMatch(/^REVERSAL /);
    // Worked back from :62F:, and consistent with :60F:.
    expect(c.balance).toBe(103950);
    expect(a.balance).toBe(110500);
  });

  it('takes the booking date across the turn of the year', () => {
    const t = transactionOf('2612310101C100,00NTRFREF');
    expect(t.date.getFullYear()).toBe(2027);
    expect(t.date.getMonth()).toBe(0);
  });

  it('works forward from the opening when there is no closing', () => {
    const [st] = parseMt940(':20:X\n:25:123456\n:60F:C261001INR1000,00\n:61:2610011001D100,00NTRFX\n:86:OUT\n');
    expect(st.rows[0].balance).toBe(900);
  });
});

let mongo, app, M, admin, feed;
let server = [];
let seenKey = null;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  feed = require('../../services/bankFeed');
  // A stand-in for the bank's server: the pinned-key rule is the real reader's, mirrored here.
  feed.setSftpReader(async (s, { isKnown, onFile }) => {
    seenKey = s.hostKey;
    if (!s.hostKey) throw new Error('The SFTP server offered the key SHA256:abc. Check it with the bank, then set BANK_SFTP_HOST_KEY to it — nothing is read until then.');
    for (const f of server) if (!(await isKnown(f.id))) await onFile(f);
  });
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'BankAccount', 'BankStatement', 'BankFeedMessage', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'sftp@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { feed.setSftpReader(null); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  server = [];
  for (const k of ['BANK_FEED_IMAP_HOST', 'BANK_FEED_IMAP_USER', 'BANK_FEED_IMAP_PASS']) delete process.env[k];
  Object.assign(process.env, { BANK_SFTP_HOST: 'sftp.kotak.test', BANK_SFTP_USER: 'balu', BANK_SFTP_PASS: 'x', BANK_SFTP_HOST_KEY: 'SHA256:abc', BANK_SFTP_DIR: '/out', BANK_FEED_EVERY_MIN: '0' });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

async function scene() {
  const customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', gstin: '33AAEPS1001F1Z2', phoneNumber: '9200000000' });
  const inv = await M.Invoice.create({
    invoiceNumber: 'INV/2026-27/0701', financialYear: '2026-27', sequence: 701, invoiceDate: new Date('2026-09-20'), dueDate: new Date('2026-10-19'),
    order: new mongoose.Types.ObjectId(), customer: customer._id, buyer: { name: customer.name }, supplyType: 'intra', lines: [], totals: { taxable: 10000, grand: 10500 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 10500 });
  const kotak = await M.BankAccount.create({ name: 'Kotak CA', kind: 'bank', accountNo: '7612149219', openingBalance: 100000 });
  const kotakOd = await M.BankAccount.create({ name: 'Kotak OD', kind: 'bank', accountNo: '7612149300', openingBalance: 0 });
  return { customer, inv, kotak, kotakOd };
}
const file = (name, text, t = 1) => ({ id: `sftp:/out/${name}:${text.length}:${t}`, name, buffer: Buffer.from(text), modifiedAt: new Date('2026-10-01T18:00:00Z') });

describe('an MT940 upload', () => {
  it('goes only into the account it names', async () => {
    const { kotak, kotakOd } = await scene();
    const text = MT('7612149219', '1001', [':61:2610011001D6300,00NCHK000101', ':86:CHQ 101 LANDLORD'], '93700,00');
    const wrong = await request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(kotakOd._id)).attach('file', Buffer.from(text), 'kotak.sta');
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/ending 9219, not Kotak OD/);
    const right = await request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(kotak._id)).attach('file', Buffer.from(text), 'kotak.sta');
    expect(right.status).toBe(200);
    expect(right.body.rows).toHaveLength(1);
    expect(right.body.closingBalance).toBe(93700);
  });
});

describe('statements from the bank\'s SFTP server', () => {
  it('reads each file once, splits it between accounts, and adds only new lines', async () => {
    const { kotak, kotakOd } = await scene();
    const day1 = MT('7612149219', '1001', [':61:2610011001C10500,00NTRFNONREF//KKBK1', ':86:NEFT CR SUNRISE GARMENTS INV/2026-27/0701'], '110500,00')
      + '\r\n' + MT('7612149300', '1001', [':61:2610011001D1200,00NMSCNONREF//KKBK2', ':86:OD INTEREST'], '98800,00');
    server = [file('KOTAK_20261001.sta', day1)];
    const r1 = await feed.run({ trigger: 'manual' });
    expect(r1).toMatchObject({ checked: 1, imported: 1, newLines: 2, error: null });
    const msg = await M.BankFeedMessage.findOne({}).lean();
    expect(msg).toMatchObject({ channel: 'sftp', status: 'imported', accountName: 'Kotak CA, Kotak OD', from: 'sftp://sftp.kotak.test' });
    const ca = await M.BankStatement.findOne({ account: kotak._id }).lean();
    expect(ca).toMatchObject({ source: 'sftp', closingBalance: 110500 });
    expect(ca.lines[0]).toMatchObject({ status: 'matched' });
    expect(ca.lines[0].suggestion.allocations[0].amount).toBe(10500);
    expect(await M.BankStatement.countDocuments({ account: kotakOd._id })).toBe(1);

    // Read again: nothing. The next day's file repeats yesterday's line and adds one.
    expect(await feed.run()).toMatchObject({ checked: 0 });
    server.push(file('KOTAK_20261002.sta', MT('7612149219', '1002', [
      ':61:2610011001C10500,00NTRFNONREF//KKBK1', ':86:NEFT CR SUNRISE GARMENTS INV/2026-27/0701',
      ':61:2610021002D50,00NMSCNONREF//KKBK3', ':86:SMS CHARGES',
    ], '110450,00'), 2));
    expect(await feed.run()).toMatchObject({ checked: 1, imported: 1, newLines: 1 });
  });

  it('reports an account number we do not have, and imports nothing', async () => {
    await scene();
    server = [file('OTHER.sta', MT('5550001111', '1001', [':61:2610011001C100,00NTRFX', ':86:X'], '100100,00'))];
    expect(await feed.run()).toMatchObject({ checked: 1, failed: 1 });
    const msg = await M.BankFeedMessage.findOne({}).lean();
    expect(msg.note).toMatch(/account 5550001111; no bank account here has that number/);
    expect(await M.BankStatement.countDocuments({})).toBe(0);
  });

  it('posts a sure match without a person when auto-post is on', async () => {
    const { inv } = await scene();
    expect((await put('/accounts/bank/feed', { autoPost: true })).body.feed.autoPost).toBe(true);
    server = [file('KOTAK_20261001.sta', MT('7612149219', '1001', [':61:2610011001C10500,00NTRFNONREF//KKBK1', ':86:NEFT CR SUNRISE GARMENTS INV/2026-27/0701'], '110500,00'))];
    expect(await feed.run()).toMatchObject({ imported: 1, posted: 1 });
    const st = await M.BankStatement.findOne({}).lean();
    expect(st.lines[0]).toMatchObject({ status: 'posted', note: "Posted from the bank's SFTP statement" });
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(10500);
  });

  it('reads nothing until the server\'s key is pinned, and says which key it saw', async () => {
    await scene();
    delete process.env.BANK_SFTP_HOST_KEY;
    server = [file('KOTAK_20261001.sta', MT('7612149219', '1001', [':61:2610011001D50,00NMSCX', ':86:SMS'], '99950,00'))];
    const r = await feed.run();
    expect(seenKey).toBe('');
    expect(r.error).toMatch(/^SFTP: The SFTP server offered the key SHA256:abc/);
    expect(await M.BankStatement.countDocuments({})).toBe(0);
    const status = (await get('/accounts/bank/feed')).body.feed;
    expect(status).toMatchObject({ configured: true, mailbox: '', sftp: { host: 'sftp.kotak.test', dir: '/out', hostKeySet: false } });
  });
});

describe('the host key check', () => {
  it('fingerprints as OpenSSH does and compares with or without the prefix', () => {
    const { fingerprint, samePrint } = require('../../services/bankFeed');
    const fp = fingerprint(Buffer.from('ssh-ed25519 key blob'));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(samePrint(fp, fp.replace('SHA256:', ''))).toBe(true);
    expect(samePrint(fp, 'SHA256:other')).toBe(false);
    expect(samePrint(fp, '')).toBe(false);
  });
});
