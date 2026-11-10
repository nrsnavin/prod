'use strict';
// ══════════════════════════════════════════════════════════════════
//  SETTINGS THAT PUT THE SYSTEM AT RISK
//
//  The signing key and the database password were once committed to the
//  repository; nothing said whether they were still in use. Held here:
//  which settings are called out and how loudly, that a production
//  server with no signing key does not start, and that a secret's value
//  is never part of what is said.
// ══════════════════════════════════════════════════════════════════

const { configRisks, announce, dbLogin } = require('../../utils/configRisks');

const GOOD_KEY = 'q7Jx2mVt9LpA4sWd8FhK3nBz6RcY1uEo5GiT0aXvM';
const good = (over = {}) => ({
  NODE_ENV: 'PRODUCTION',
  JWT_SECRET_KEY: GOOD_KEY,
  MONGO_URL: 'mongodb+srv://jarvis_prod:Zk4v9QmT2xLp8RwY@cluster0.example.mongodb.net/baluElastics',
  AADHAAR_KEY: 'c2VjcmV0LWtleS10aGF0LWlzLTMyLWJ5dGVzLWxvbmc=',
  CORS_ORIGINS: 'https://erp.example.com',
  ...over,
});
const levels = (env) => Object.fromEntries(configRisks(env).map((r) => [r.key, r.level]));

describe('the signing key', () => {
  it('missing is fatal', () => {
    expect(levels(good({ JWT_SECRET_KEY: '' }))).toEqual({ JWT_SECRET_KEY: 'fatal' });
    expect(levels(good({ JWT_SECRET_KEY: undefined }))).toEqual({ JWT_SECRET_KEY: 'fatal' });
  });

  it('the one committed to the repository is a risk, in any letter case', () => {
    for (const key of ['balutapes', 'BaluTapes', 'secret', 'changeme']) {
      const [risk] = configRisks(good({ JWT_SECRET_KEY: key }));
      expect(risk).toMatchObject({ key: 'JWT_SECRET_KEY', level: 'risk' });
      expect(risk.message).toMatch(/public or easily guessed/);
      expect(risk.message).toMatch(/SECRETS_ROTATION/);
    }
  });

  it('a short one is a risk', () => {
    const [risk] = configRisks(good({ JWT_SECRET_KEY: 'only-twenty-chars-xx' }));
    expect(risk).toMatchObject({ key: 'JWT_SECRET_KEY', level: 'risk' });
    expect(risk.message).toMatch(/20 characters/);
  });

  it('the portal\'s own key is held to the same, but may be absent', () => {
    expect(levels(good({ PORTAL_JWT_SECRET_KEY: 'balutapes' }))).toEqual({ PORTAL_JWT_SECRET_KEY: 'risk' });
    expect(levels(good({ PORTAL_JWT_SECRET_KEY: GOOD_KEY }))).toEqual({});
  });
});

describe('the database login', () => {
  it('the one committed to the repository is a risk', () => {
    const [risk] = configRisks(good({ MONGO_URL: 'mongodb+srv://navin:navin@cluster0.example.mongodb.net/baluElastics?appName=Cluster0' }));
    expect(risk).toMatchObject({ key: 'MONGO_URL', level: 'risk' });
    expect(risk.message).toMatch(/password is one that is public/);
  });

  it('a password equal to the user name, or very short, is a risk', () => {
    expect(levels(good({ MONGO_URL: 'mongodb://jarvis:jarvis@db.internal/app' }))).toEqual({ MONGO_URL: 'risk' });
    expect(levels(good({ MONGO_URL: 'mongodb://jarvis:abc@db.internal/app' }))).toEqual({ MONGO_URL: 'risk' });
  });

  it('reads a login out of either kind of address, percent-encoding included', () => {
    expect(dbLogin('mongodb://u:p%40ss@h/db')).toEqual({ user: 'u', password: 'p@ss' });
    expect(dbLogin('mongodb+srv://u:pw@h/db')).toEqual({ user: 'u', password: 'pw' });
    expect(dbLogin('mongodb://localhost:27017/db')).toBeNull();
    expect(dbLogin(undefined)).toBeNull();
  });

  it('the same user with a new password is fine', () => {
    expect(levels(good({ MONGO_URL: 'mongodb+srv://navin:Zk4v9QmT2xLp8RwY@cluster0.example.mongodb.net/baluElastics' }))).toEqual({});
  });
});

describe('the rest', () => {
  it('a short cron secret is a risk; none at all is not (the routes are then off)', () => {
    expect(levels(good({ CRON_SECRET: 'abc123' }))).toEqual({ CRON_SECRET: 'risk' });
    expect(levels(good({ CRON_SECRET: '' }))).toEqual({});
    expect(levels(good({ CRON_SECRET: 'f3Kq9ZxT7mLp2WvB8nRd' }))).toEqual({});
  });

  it('identity numbers stored unencrypted in production is a risk', () => {
    expect(levels(good({ AADHAAR_KEY: '' }))).toEqual({ AADHAAR_KEY: 'risk' });
    expect(levels(good({ NODE_ENV: 'development', AADHAAR_KEY: '' }))).toEqual({});
  });

  it('nothing to say about good settings', () => {
    expect(configRisks(good())).toEqual([]);
  });

  it('never repeats a secret back', () => {
    const env = good({
      JWT_SECRET_KEY: 'balutapes', PORTAL_JWT_SECRET_KEY: 'short-portal-key',
      MONGO_URL: 'mongodb://navin:navin@db.internal/app', CRON_SECRET: 'cron-abc',
    });
    const said = JSON.stringify(configRisks(env));
    for (const secret of ['balutapes', 'short-portal-key', 'navin', 'cron-abc']) expect(said).not.toContain(secret);
  });
});

describe('at start-up', () => {
  const quiet = () => ({ error: jest.fn(), warn: jest.fn() });

  it('a production server with no signing key does not start, and says why', () => {
    const log = quiet(); const exit = jest.fn();
    announce({ env: good({ JWT_SECRET_KEY: '' }), log, exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls.flat().join('\n')).toMatch(/JWT_SECRET_KEY is not set/);
  });

  it('a published key is logged loudly but the server still starts', () => {
    // Refusing to start would take the factory down on a deploy; the
    // owner is told every morning instead (utils/systemHealth.js).
    const log = quiet(); const exit = jest.fn();
    const risks = announce({ env: good({ JWT_SECRET_KEY: 'balutapes' }), log, exit });
    expect(exit).not.toHaveBeenCalled();
    expect(risks).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] RISK: JWT_SECRET_KEY/));
  });

  it('outside production nothing stops a start', () => {
    const log = quiet(); const exit = jest.fn();
    announce({ env: { NODE_ENV: 'development' }, log, exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it('good settings say nothing', () => {
    const log = quiet(); const exit = jest.fn();
    expect(announce({ env: good(), log, exit })).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
