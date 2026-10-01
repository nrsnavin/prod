'use strict';

// ══════════════════════════════════════════════════════════════════
//  AADHAAR NUMBERS — sealed at rest, masked in every answer
//
//  An Aadhaar number is a national identity number. It was stored as
//  plain text and returned in full to anyone who could open an
//  employee — and, through five unrestricted `populate('employee')`
//  calls, to screens that never showed it.
//
//    • Employee.aadhar is `select: false`, so no query returns it unless
//      it asks by name (only the employee routes do).
//    • seal(): with AADHAAR_KEY set (32 bytes, base64), the number is
//      encrypted with AES-256-GCM before it is saved, as
//      "enc:v1:<iv>:<tag>:<ciphertext>". Without a key it is stored as
//      typed, as before, and a warning is logged once.
//    • open(): reads either form, so records saved before the key was
//      set keep working; scripts/encrypt-aadhaar.js seals them in place.
//    • mask(): "XXXX XXXX 1234" — what everyone but an admin sees.
//
//  Losing AADHAAR_KEY loses the sealed numbers. Keep it with the other
//  secrets in config/.env, and back it up the same way.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
let warned = false;

function key() {
  const raw = process.env.AADHAAR_KEY;
  if (!raw) {
    if (!warned) {
      warned = true;
      console.warn('[aadhaar] AADHAAR_KEY is not set: Aadhaar numbers are stored unencrypted');
    }
    return null;
  }
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('AADHAAR_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return k;
}

const isSealed = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

/** The value to store for a typed number: sealed when a key is set. */
function seal(plain) {
  if (plain == null || plain === '') return plain;
  const text = String(plain).trim();
  if (isSealed(text)) return text;
  const k = key();
  if (!k) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** The number as typed, from either a sealed or a legacy plain value. */
function open(stored) {
  if (!isSealed(stored)) return stored ?? null;
  const k = key();
  if (!k) throw new Error('An Aadhaar number is encrypted but AADHAAR_KEY is not set');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** "XXXX XXXX 1234": enough to tell two people apart, not enough to use. */
function mask(plain) {
  if (!plain) return null;
  const digits = String(plain).replace(/\D/g, '');
  return digits.length >= 4 ? `XXXX XXXX ${digits.slice(-4)}` : 'XXXX';
}

/** A value that came back from a masked field rather than being typed. */
const looksMasked = (v) => typeof v === 'string' && /[Xx•*]/.test(v);

module.exports = { seal, open, mask, isSealed, looksMasked };
