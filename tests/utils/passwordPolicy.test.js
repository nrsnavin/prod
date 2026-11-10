'use strict';
// What a new password must be — utils/passwordPolicy.js. The routes that
// ask it (sign-up, reset, the Users screen) are tested where they live;
// this holds the rule itself.

const { passwordProblem, MIN_LENGTH } = require('../../utils/passwordPolicy');

describe('a new password', () => {
  it('needs eight characters', () => {
    expect(MIN_LENGTH).toBe(8);
    expect(passwordProblem('abcdefg')).toMatch(/at least 8/);
    expect(passwordProblem('abcdefgh1')).toBeNull();
  });

  it('must be there, and be text', () => {
    for (const nothing of ['', null, undefined, 12345678, {}, ['password1']]) {
      expect(passwordProblem(nothing)).toBe('Enter a password');
    }
  });

  it('cannot be one of the first things anyone tries, in any letter case', () => {
    for (const easy of ['password', 'Password1', '12345678', 'QWERTYUI', 'BaluElastics', 'balu1234', 'aaaaaaaa', '00000000']) {
      expect(passwordProblem(easy)).toMatch(/easy to guess/);
    }
  });

  it('cannot be the person\'s own name or email', () => {
    expect(passwordProblem('ravikumar', { name: 'Ravi Kumar' })).toMatch(/your name/);
    expect(passwordProblem('RaviKumar', { name: 'ravi kumar' })).toMatch(/your name/);
    expect(passwordProblem('ravi.kumar@balu.in', { email: 'Ravi.Kumar@balu.in' })).toMatch(/your email/);
    expect(passwordProblem('ravi.kumar', { email: 'ravi.kumar@balu.in' })).toMatch(/your email/);
  });

  it('is not refused for merely containing them', () => {
    expect(passwordProblem('ravikumar-loom-42', { name: 'Ravi Kumar', email: 'ravi@balu.in' })).toBeNull();
  });

  it('is capped, so a megabyte is never hashed', () => {
    expect(passwordProblem('x'.repeat(1025) + 'y')).toMatch(/too long/);
    expect(passwordProblem('xy'.repeat(512))).toBeNull();
  });

  it('accepts a passphrase, spaces and other scripts included', () => {
    expect(passwordProblem('loom shed number nine')).toBeNull();
    expect(passwordProblem('நெசவு-தறி-42')).toBeNull();
  });
});
