'use strict';
// An address this server is told to call, with credentials in the
// headers (the e-invoice provider's): https only, and nowhere inside the
// server's own network. utils/outboundUrl.js.

const { outboundUrlProblem, isInside } = require('../../utils/outboundUrl');

const prod = { production: true };
const dev = { production: false };

describe('an address to call with credentials', () => {
  it('is https', () => {
    expect(outboundUrlProblem('https://gsp.example/api', prod)).toBeNull();
    expect(outboundUrlProblem('http://gsp.example/api', prod)).toMatch(/https/);
    expect(outboundUrlProblem('http://gsp.example/api', dev)).toMatch(/https/);
    for (const other of ['ftp://gsp.example', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x']) {
      expect(outboundUrlProblem(other, prod)).toMatch(/https/);
    }
  });

  it('is a web address at all', () => {
    for (const junk of ['', '   ', 'gsp.example/api', 'not a url', null, undefined]) {
      expect(outboundUrlProblem(junk, prod)).toMatch(/not a web address/);
    }
  });

  it('carries no user name or password of its own', () => {
    expect(outboundUrlProblem('https://user:pw@gsp.example/api', prod)).toMatch(/user name and password/);
  });

  it('is not inside this server\'s network, in production', () => {
    for (const inside of [
      'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://172.16.4.1/x', 'https://172.31.255.255/x',
      'https://192.168.1.10/x', 'https://169.254.169.254/latest/meta-data/', 'https://0.0.0.0/x', 'https://100.64.0.1/x',
      'https://[::1]/x', 'https://[fd12:3456::1]/x', 'https://[fe80::1]/x', 'https://[::ffff:10.0.0.1]/x',
      'https://db.internal/x', 'https://printer.local/x',
    ]) {
      expect(outboundUrlProblem(inside, prod)).toMatch(/inside this server/);
    }
  });

  it('CONTROL: an address that merely looks like one is fine', () => {
    for (const fine of ['https://172.15.0.1/x', 'https://172.32.0.1/x', 'https://11.0.0.1/x', 'https://193.168.1.1/x', 'https://local.example.com/x', 'https://internal.example.com/x']) {
      expect(outboundUrlProblem(fine, prod)).toBeNull();
    }
  });

  it('outside production a provider stub on the developer\'s machine is allowed', () => {
    expect(outboundUrlProblem('http://localhost:9090/gsp', dev)).toBeNull();
    expect(outboundUrlProblem('http://127.0.0.1:9090/gsp', dev)).toBeNull();
    expect(outboundUrlProblem('http://localhost:9090/gsp', prod)).toMatch(/https/);
  });

  it('isInside reads names and numbers', () => {
    expect(isInside('LOCALHOST')).toBe(true);
    expect(isInside('8.8.8.8')).toBe(false);
    expect(isInside('gsp.example')).toBe(false);
  });
});
