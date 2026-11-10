'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ADDRESS THIS SERVER IS TOLD TO CALL
//
//  Settings → Invoice takes the address of the e-invoice provider, and
//  every call to it carries the provider's credentials and the GSTIN in
//  its headers. Anything typed there was accepted: http:// (the
//  credentials in the clear), or an address inside the server's own
//  network (the cloud's metadata service, the database's admin port),
//  whose answer comes back in the error message.
//
//  outboundUrlProblem says why an address must not be called, or null.
//  It reads the address as written; it cannot know what a name resolves
//  to, so a public-looking name pointing inward is the network's to stop.
// ══════════════════════════════════════════════════════════════════

const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

/** An address written as a number, or a name that only exists inside. */
function isInside(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_NAMES.has(host) || /\.(local|internal|localdomain|lan)$/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)          // link-local: cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT
  }
  if (host.includes(':')) {
    // IPv6: loopback, unspecified, unique-local, link-local, v4-mapped.
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  }
  return false;
}

/**
 * Why `raw` must not be called, or null when it may be.
 * @param {string} raw
 * @param {{ production?: boolean }} [o] outside production a local http
 *        address is allowed, for a provider stub on the developer's machine
 */
function outboundUrlProblem(raw, { production = process.env.NODE_ENV === 'PRODUCTION' } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch (_) {
    return 'That is not a web address';
  }
  if (url.username || url.password) return 'Leave the user name and password out of the address';
  const inside = isInside(url.hostname);
  if (url.protocol === 'http:') {
    if (production || !inside) return 'The address must start with https://';
  } else if (url.protocol !== 'https:') {
    return 'The address must start with https://';
  }
  if (production && inside) return 'That address is inside this server\'s own network';
  return null;
}

module.exports = { outboundUrlProblem, isInside };
