'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A NEW PASSWORD MUST BE
//
//  Four characters was the rule, checked in four places in four slightly
//  different sentences. This holds the books, the payroll and people's
//  Aadhaar numbers; the rule is now one, here:
//
//    • at least 8 characters;
//    • not one of the handful everybody tries first;
//    • not the person's own name or email.
//
//  It is asked of NEW passwords only (creating a login, changing one,
//  resetting one). Nobody is locked out of a password they already have.
// ══════════════════════════════════════════════════════════════════

const MIN_LENGTH = 8;
const MAX_LENGTH = 1024;

const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'abcd1234', 'abcdefgh', 'iloveyou',
  'admin123', 'admin1234', 'administrator', 'welcome1', 'welcome123', 'letmein1', 'changeme',
  'balu1234', 'baluelastics', 'balutapes', 'elastics',
]);

/**
 * Why `password` cannot be used, or null when it can.
 * @param {string} password
 * @param {{ email?: string, name?: string }} [who]
 */
function passwordProblem(password, { email = '', name = '' } = {}) {
  if (typeof password !== 'string' || !password) return 'Enter a password';
  if (password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (password.length > MAX_LENGTH) return 'That password is too long';
  const p = password.toLowerCase();
  if (COMMON.has(p)) return 'That password is too easy to guess — choose another';
  if (/^(.)\1+$/.test(password)) return 'That password is too easy to guess — choose another';
  const local = String(email || '').toLowerCase().split('@')[0];
  if (local.length >= 4 && p === local) return 'The password cannot be your email';
  if (String(email || '').toLowerCase() === p) return 'The password cannot be your email';
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (n.length >= 4 && p === n) return 'The password cannot be your name';
  return null;
}

module.exports = { passwordProblem, MIN_LENGTH };
