'use strict';
// ══════════════════════════════════════════════════════════════════
//  SETTINGS THAT PUT THE SYSTEM AT RISK, SAID OUT LOUD
//
//  Two credentials were once committed to this repository and are still
//  in its history (deploy/SECRETS_ROTATION.md): the signing key and the
//  database login. Whoever has seen the repository can sign in as any
//  user with the first and read or change every record with the second —
//  and nothing in the running system said whether either was still in
//  use. The server started the same with a published key as with a good
//  one, and with no key at all (then every sign-in failed with a 500
//  that named nothing).
//
//  This reads the settings the way an attacker would and says what it
//  finds, in three weights:
//
//    fatal  the server cannot do its job. In production it does not
//           start, and the log says which setting to fix.
//    risk   it runs, and someone has to act: logged at start, listed on
//           /health/build, and sent to the owner each morning until it
//           is fixed (utils/systemHealth.js).
//    note   worth knowing; logged and listed only.
//
//  It never prints a secret — only which one, and what is wrong with it.
// ══════════════════════════════════════════════════════════════════

/** Signing keys that are public or that anyone would try first. */
const PUBLISHED_KEYS = new Set([
  'balutapes', // committed to this repository
  'secret', 'jwtsecret', 'jwt_secret', 'jwt-secret', 'changeme', 'change-me', 'password',
  'test', 'test-secret', 'dev', 'development', 'your-secret-key', 'supersecret', 'mysecret',
]);

/** Database logins that are public: user → password. */
const PUBLISHED_DB_LOGINS = { navin: 'navin' }; // committed to this repository

const MIN_KEY_LENGTH = 32;
const MIN_SHARED_SECRET_LENGTH = 16;

const ROTATE = 'See deploy/SECRETS_ROTATION.md.';

function signingKeyRisks(name, value, { required }) {
  const key = String(value || '');
  if (!key) {
    return required
      ? [{ key: name, level: 'fatal', message: `${name} is not set — nobody can sign in. Set it to a long random value (openssl rand -base64 48).` }]
      : [];
  }
  if (PUBLISHED_KEYS.has(key.toLowerCase())) {
    return [{
      key: name, level: 'risk',
      message: `${name} is a value that is public or easily guessed. Anyone who knows it can sign in as any user, an administrator included. Change it now. ${ROTATE}`,
    }];
  }
  if (key.length < MIN_KEY_LENGTH) {
    return [{
      key: name, level: 'risk',
      message: `${name} is ${key.length} characters — short enough to be guessed by a machine. Use at least ${MIN_KEY_LENGTH} random characters (openssl rand -base64 48). ${ROTATE}`,
    }];
  }
  return [];
}

/** The user and password in a MongoDB address, or null. */
function dbLogin(url) {
  const m = /^mongodb(?:\+srv)?:\/\/([^:@/]+):([^@/]*)@/i.exec(String(url || ''));
  if (!m) return null;
  const decode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  return { user: decode(m[1]), password: decode(m[2]) };
}

function databaseRisks(env) {
  const login = dbLogin(env.MONGO_URL);
  if (!login) return [];
  if (PUBLISHED_DB_LOGINS[login.user] === login.password) {
    return [{
      key: 'MONGO_URL', level: 'risk',
      message: `The database password is one that is public. Anyone who knows it can read and change every record, bypassing this server entirely. Change it now. ${ROTATE}`,
    }];
  }
  if (login.password && (login.password === login.user || login.password.length < 8)) {
    return [{
      key: 'MONGO_URL', level: 'risk',
      message: `The database password is ${login.password === login.user ? 'the same as the user name' : 'very short'}. Give the database user a long generated password. ${ROTATE}`,
    }];
  }
  return [];
}

/**
 * Everything wrong with these settings.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ key: string, level: 'fatal'|'risk'|'note', message: string }>}
 */
function configRisks(env = process.env) {
  const production = env.NODE_ENV === 'PRODUCTION';
  const out = [
    ...signingKeyRisks('JWT_SECRET_KEY', env.JWT_SECRET_KEY, { required: true }),
    // Optional: the customer portal signs with the main key when unset.
    ...signingKeyRisks('PORTAL_JWT_SECRET_KEY', env.PORTAL_JWT_SECRET_KEY, { required: false }),
    ...databaseRisks(env),
  ];

  const cron = String(env.CRON_SECRET || '');
  if (cron && cron.length < MIN_SHARED_SECRET_LENGTH) {
    out.push({
      key: 'CRON_SECRET', level: 'risk',
      message: `CRON_SECRET is ${cron.length} characters. It is all that stops anyone on the internet from triggering the scheduled reports; use at least ${MIN_SHARED_SECRET_LENGTH} random characters.`,
    });
  }

  if (production && !env.AADHAAR_KEY) {
    out.push({
      key: 'AADHAAR_KEY', level: 'risk',
      message: 'AADHAAR_KEY is not set, so employees\' Aadhaar numbers are stored unencrypted. Set it (openssl rand -base64 32), back it up with the other secrets, then run scripts/encrypt-aadhaar.js to seal the numbers already stored.',
    });
  }

  if (production && !String(env.CORS_ORIGINS || '').trim()) {
    out.push({
      key: 'CORS_ORIGINS', level: 'note',
      message: 'CORS_ORIGINS is empty: no web app is allowed to call this API from a browser.',
    });
  }
  return out;
}

/**
 * Say them at start-up. In production a fatal one stops the process:
 * a server that cannot sign anyone in is better down, with the reason
 * in the log, than up and answering every sign-in with an error.
 * @returns the risks, for callers that want them
 */
function announce({ env = process.env, log = console, exit = (code) => process.exit(code) } = {}) {
  const risks = configRisks(env);
  for (const r of risks) {
    const line = `[config] ${r.level.toUpperCase()}: ${r.message}`;
    if (r.level === 'note') log.warn(line);
    else log.error(line);
  }
  if (env.NODE_ENV === 'PRODUCTION' && risks.some((r) => r.level === 'fatal')) {
    log.error('[config] Not starting: fix the setting above and restart.');
    exit(1);
  }
  return risks;
}

module.exports = { configRisks, announce, dbLogin, MIN_KEY_LENGTH };
