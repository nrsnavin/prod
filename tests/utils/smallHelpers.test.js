'use strict';
// ══════════════════════════════════════════════════════════════════
//  THREE SMALL HELPERS, EACH HELD TO ONE RULE
//
//  • The production switch is the exact word PRODUCTION. Spelt the way
//    most tools spell it ("production"), the server runs with its
//    development allowances on and says nothing — so it now says so.
//  • A material group named after the form's own slot, "Warp Spandex",
//    belongs in the warp-spandex slot, not with the warp yarns.
//  • A line break inside a value printed on one line is a space, not
//    nothing: "Main Road\nTiruppur" is not "Main RoadTiruppur".
//  • A date of birth off an identity card's code is a day that exists.
// ══════════════════════════════════════════════════════════════════

const { configRisks } = require('../../utils/configRisks');
const { bucketFor } = require('../../utils/recipeMaterials');
const { latin1 } = require('../../utils/pdfLatin');
const { dobOf } = require('../../utils/aadhaarQr');

const GOOD_KEY = 'q7Jx2mVt9LpA4sWd8FhK3nBz6RcY1uEo5GiT0aXvM';
const env = (over = {}) => ({
  NODE_ENV: 'PRODUCTION',
  JWT_SECRET_KEY: GOOD_KEY,
  MONGO_URL: 'mongodb+srv://jarvis_prod:Zk4v9QmT2xLp8RwY@cluster0.example.mongodb.net/baluElastics',
  AADHAAR_KEY: 'c2VjcmV0LWtleS10aGF0LWlzLTMyLWJ5dGVzLWxvbmc=',
  CORS_ORIGINS: 'https://erp.example.com',
  ...over,
});

describe('the production switch', () => {
  it.each(['production', 'Production', 'prod', 'PROD', ' PRODUCTION '])('NODE_ENV=%j is called out: it is not the word the server looks for', (value) => {
    const risks = configRisks(env({ NODE_ENV: value }));
    const said = risks.find((r) => r.key === 'NODE_ENV');
    expect(said).toBeTruthy();
    expect(said.level).toBe('risk');
    expect(said.message).toMatch(/PRODUCTION/);
  });

  it.each(['PRODUCTION', 'development', 'test', 'staging', '', undefined])('NODE_ENV=%j says nothing', (value) => {
    const risks = configRisks(env({ NODE_ENV: value }));
    expect(risks.find((r) => r.key === 'NODE_ENV')).toBeUndefined();
  });
});

describe('which slot a material group feeds', () => {
  it('the plain names', () => {
    expect(bucketFor('warp')).toBe('warp');
    expect(bucketFor('Warp Yarn')).toBe('warp');
    expect(bucketFor('Weft')).toBe('weft');
    expect(bucketFor('Rubber')).toBe('rubber');
    expect(bucketFor('Spandex')).toBe('rubber');
    expect(bucketFor('covering')).toBe('covering');
    expect(bucketFor('Chemicals')).toBeNull();
  });

  it('a group named for the warp-spandex slot feeds that slot, not the warp yarns', () => {
    expect(bucketFor('Warp Spandex')).toBe('rubber');
    expect(bucketFor('warp rubber')).toBe('rubber');
  });

  it('the yarn that covers the spandex is covering, whatever else its name says', () => {
    expect(bucketFor('Spandex Covering')).toBe('covering');
    expect(bucketFor('Covering yarn (warp side)')).toBe('covering');
  });
});

describe('text for the built-in PDF font', () => {
  it('a line break or a tab is a space between the words', () => {
    expect(latin1('No. 12 Main Road\nTiruppur\t641604')).toBe('No. 12 Main Road Tiruppur 641604');
    expect(latin1('first\r\nsecond')).toBe('first second');
  });

  it('what it did before, it still does', () => {
    expect(latin1('Rate ₹ 12 – net')).toBe('Rate Rs. 12 - net');
    expect(latin1('  two   spaces  ')).toBe('two spaces');
    expect(latin1('தமிழ் Kumar')).toBe('Kumar');
    expect(latin1(null)).toBe('');
  });
});

describe('a date of birth read off an Aadhaar code', () => {
  it('each way it is written', () => {
    expect(dobOf('04-07-1990')).toBe('1990-07-04');
    expect(dobOf('04/07/1990')).toBe('1990-07-04');
    expect(dobOf('1990-07-04')).toBe('1990-07-04');
    expect(dobOf('1990')).toBe('1990-01-01');
    expect(dobOf('29-02-2000')).toBe('2000-02-29');
  });

  it('a day that does not exist is no date of birth', () => {
    expect(dobOf('31-02-1990')).toBeNull();
    expect(dobOf('31-04-1990')).toBeNull();
    expect(dobOf('29-02-1999')).toBeNull();
    expect(dobOf('00-07-1990')).toBeNull();
    expect(dobOf('04-13-1990')).toBeNull();
    expect(dobOf('04-07-1890')).toBeNull();
    expect(dobOf('04-07-2990')).toBeNull();
    expect(dobOf('')).toBeNull();
  });
});

describe('the last line of a ledger account sent to a party', () => {
  const { buildStatementPdf } = require('../../utils/accountsPdf');
  const { pdfText } = require('../helpers/pdfText');
  const statement = (closing) => ({
    opening: 0, openingSide: '', rows: [], totals: { debit: 0, credit: 0 },
    closing, closingSide: closing > 0 ? 'Dr' : closing < 0 ? 'Cr' : '',
  });
  const lastLine = async (closing, partyType = 'customer') => pdfText(await buildStatementPdf({
    statement: statement(closing), party: { name: 'Acme Garments' }, partyType, to: new Date('2026-11-20T00:00:00Z'),
  }));

  it('a settled account says so, rather than "Held for you: 0.00"', async () => {
    const customer = await lastLine(0);
    expect(customer).toContain('Nothing is due either way');
    expect(customer).not.toMatch(/Held for you|Due from you/);
    const supplier = await lastLine(0, 'supplier');
    expect(supplier).toContain('Nothing is due either way');
    expect(supplier).not.toMatch(/Paid ahead to you|Due to you/);
  });

  it('a balance either way reads as it did', async () => {
    expect(await lastLine(1500)).toMatch(/Due from you: .*1,500\.00/);
    expect(await lastLine(-200)).toMatch(/Held for you: .*200\.00/);
    expect(await lastLine(900, 'supplier')).toMatch(/Due to you: .*900\.00/);
    expect(await lastLine(-50, 'supplier')).toMatch(/Paid ahead to you: .*50\.00/);
  });
});
