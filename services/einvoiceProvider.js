'use strict';
// ══════════════════════════════════════════════════════════════════
//  E-INVOICE PROVIDER (GSP) INTERFACE
//
//  Registering an IRN means sending the INV-01 JSON to the Invoice
//  Registration Portal through a GST Suvidha Provider. Which one, and
//  the credentials, live in Settings → Invoice (DocumentSettings
//  .invoice.gsp; the secrets are select:false and only read here).
//
//  A provider is an object:
//
//      {
//        register(payload, { invoice }) → { irn, ackNo, ackDate, signedQr, raw }
//        cancel(irn, { reason, invoice }) → { cancelledAt, raw }
//      }
//
//  built by a factory in PROVIDERS from the stored config. With no
//  provider connected, register() throws EINVOICE_NOT_CONFIGURED and
//  the screen offers the other door: paste the IRN and signed QR that
//  the portal (or the accountant's GSP console) gives back.
//
//  Two adapters ship:
//    "http-json"  a plain POST of the INV-01 JSON to the configured URL
//                 with the credentials as headers, taking back the
//                 portal's standard field names (most GSP proxies);
//    "cleartax"   ClearTax's own e-invoicing API (see CLEARTAX below).
//  A provider with its own handshake (a token call first, encryption)
//  gets its own factory here.
// ══════════════════════════════════════════════════════════════════

const DocumentSettings = require('../models/DocumentSettings');
const ErrorHandler = require('../utils/ErrorHandler');
const { outboundUrlProblem } = require('../utils/outboundUrl');

const failure = (message, code, status = 409) => {
  const err = new ErrorHandler(message, status);
  err.code = code;
  return err;
};

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(obj || {}).find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit && obj[hit] !== undefined && obj[hit] !== null && obj[hit] !== '') return obj[hit];
  }
  return undefined;
};

/** Parse "dd/mm/yyyy HH:MM:SS" (the portal's AckDt) or anything Date can. */
function readAckDate(v) {
  if (!v) return new Date();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(String(v));
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // "2026-11-13 10:30:00" (ClearTax): the portal's clock, India time.
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(String(v));
  if (iso) return new Date(`${iso[1]}T${iso[2]}+05:30`);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** The portal's reply, whatever casing the proxy used. */
function readRegistration(body) {
  const data = pick(body, 'Data', 'data', 'result') && typeof pick(body, 'Data', 'data', 'result') === 'object'
    ? pick(body, 'Data', 'data', 'result') : body;
  const irn = pick(data, 'Irn', 'irn');
  if (!irn) {
    const msg = pick(body, 'ErrorDetails', 'message', 'error', 'errors');
    throw failure(
      `The e-invoice provider did not return an IRN${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300)}` : ''}.`,
      'EINVOICE_REJECTED', 502
    );
  }
  return {
    irn: String(irn),
    ackNo: String(pick(data, 'AckNo', 'ackNo') ?? ''),
    ackDate: readAckDate(pick(data, 'AckDt', 'ackDt', 'ackDate')),
    signedQr: String(pick(data, 'SignedQRCode', 'signedQRCode', 'signedQr') ?? ''),
    raw: data,
  };
}

// How long the provider is given to answer. fetch has no limit of its
// own, so a provider that accepted the connection and then said nothing
// held the request — and the person waiting on it — indefinitely.
const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * POST `body` to the provider at `path`, with its credentials.
 * @returns {{ res: Response, body: object }}
 */
async function callProvider(cfg, path, body, { notConfigured = 'EINVOICE_NOT_CONFIGURED', rejected = 'EINVOICE_REJECTED' } = {}) {
  if (!cfg.baseUrl) throw failure('The GSP has no URL in Settings → Invoice.', notConfigured);
  // Checked when it is saved too; this covers one stored before that.
  const problem = outboundUrlProblem(cfg.baseUrl);
  if (problem) throw failure(`The e-invoice provider's address in Settings → Invoice cannot be used: ${problem}.`, notConfigured);
  let res;
  try {
    res = await fetch(cfg.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'client-id': cfg.clientId || '',
        'client-secret': cfg.clientSecret || '',
        username: cfg.username || '',
        password: cfg.password || '',
        gstin: cfg.gstin || '',
      },
      body: JSON.stringify(body),
      redirect: 'error', // the credentials go to the address in Settings, nowhere it points on to
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw failure(
      slow ? 'The e-invoice provider did not answer in time. Check on the portal before trying again — it may have gone through.'
           : 'The e-invoice provider could not be reached. Try again in a minute.',
      rejected, 502
    );
  }
  let reply;
  try { reply = await res.json(); } catch { reply = {}; }
  return { res, body: reply };
}

// ── CLEARTAX ──────────────────────────────────────────────────────
// ClearTax's own e-invoicing API (docs.cleartax.in → E-Invoicing API →
// Govt compatible APIs):
//
//    POST {host}/einv/v1/govt/api/Invoice/           the INV-01 JSON as it is
//    POST {host}/einv/v1/govt/api/Cancel             { irn, CnlRsn, CnlRem }
//    POST {host}/einv/v1/govt/api/einvewb/ewaybill   { Irn, Distance, TransMode, … }
//
// with the headers x-cleartax-auth-token (the workspace's token, made in
// ClearTax), x-cleartax-product: EInvoice and gstin. The reply carries
// the portal's fields at its top level, with Success "Y" or "N" and
// ErrorDetails. The IRP API user's name and password are kept in
// ClearTax, added there with the GSTIN; they are not sent from here.
// Host: https://api.clear.in, or https://api-sandbox.clear.in for
// ClearTax's sandbox (which takes only its own test GSTINs).
const CLEARTAX_HOST = 'https://api.clear.in';

// The token opens the company's ClearTax workspace, so it is sent to
// ClearTax only: not to an address left in Settings from a GSP used
// before, nor to one typed by mistake.
const CLEARTAX_DOMAINS = ['clear.in', 'cleartax.in', 'cleartax.co'];
function onClearTax(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return CLEARTAX_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

async function callClearTax(cfg, path, body, rejected = 'EINVOICE_REJECTED') {
  const base = (cfg.baseUrl || CLEARTAX_HOST).replace(/\/$/, '');
  const problem = outboundUrlProblem(base);
  if (problem) throw failure(`ClearTax's address in Settings → Invoice cannot be used: ${problem}.`, 'EINVOICE_NOT_CONFIGURED');
  if (!onClearTax(base)) {
    throw failure(`The address in Settings → Invoice (${base}) is not ClearTax's. Choose Live or Sandbox there and save.`, 'EINVOICE_NOT_CONFIGURED');
  }
  if (!cfg.clientSecret) throw failure('No ClearTax auth token in Settings → Invoice.', 'EINVOICE_NOT_CONFIGURED');
  if (!cfg.gstin) throw failure('Your GSTIN is missing (Settings → Documents): ClearTax needs it.', 'EINVOICE_NOT_CONFIGURED');
  let res;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cleartax-auth-token': cfg.clientSecret,
        'x-cleartax-product': 'EInvoice',
        gstin: cfg.gstin,
      },
      body: JSON.stringify(body),
      redirect: 'error', // the token goes to ClearTax's address, nowhere it points on to
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw failure(
      slow ? 'ClearTax did not answer in time. Check on ClearTax or the portal before trying again: it may have gone through.'
           : 'ClearTax could not be reached. Try again in a minute.',
      rejected, 502
    );
  }
  let reply;
  try { reply = await res.json(); } catch { reply = {}; }
  return { res, body: reply };
}

/** ClearTax's errors in its own words: "2150: Duplicate IRN; …". */
function clearTaxErrors(body) {
  const list = Array.isArray(body?.ErrorDetails) ? body.ErrorDetails
    : Array.isArray(body?.errors?.errors) ? body.errors.errors
      : Array.isArray(body?.errors) ? body.errors : [];
  const said = list
    .map((e) => [e?.error_code ?? e?.ErrorCode ?? e?.code, e?.error_message ?? e?.ErrorMessage ?? e?.message].filter((x) => x !== undefined && x !== null && x !== '').join(': '))
    .filter(Boolean)
    .join('; ');
  return said || String(body?.message || body?.error_message || '');
}

const refusal = (what, res, body, code) => {
  const why = clearTaxErrors(body);
  return failure(`ClearTax ${what}${res.ok ? '' : ` (${res.status})`}${why ? `: ${why}` : ''}.`, code, 502);
};

const PROVIDERS = {
  cleartax: (cfg) => ({
    async register(payload) {
      const { res, body } = await callClearTax(cfg, '/einv/v1/govt/api/Invoice/', payload);
      // A repeat of an invoice ClearTax already registered comes back as a
      // success with the same IRN (info DUPIRN_CLEARTAX): taken as one.
      if (body?.Success === 'Y' && body?.Irn) {
        return {
          irn: String(body.Irn),
          ackNo: String(body.AckNo ?? ''),
          ackDate: readAckDate(body.AckDt),
          signedQr: String(body.SignedQRCode ?? ''),
          raw: body,
        };
      }
      const err = refusal('did not register it', res, body, 'EINVOICE_REJECTED');
      if (/\b2150\b/.test(err.message)) {
        err.message += ' The portal already has an IRN for this invoice number: paste it in from the portal or ClearTax ("Paste IRN…").';
      }
      throw err;
    },
    async ewaybill(payload) {
      const { res, body } = await callClearTax(cfg, '/einv/v1/govt/api/einvewb/ewaybill', payload, 'EWB_REJECTED');
      if (body?.EwbNo && body?.Success !== 'N' && body?.EwbStatus !== 'FAILED') {
        return {
          number: String(body.EwbNo),
          generatedAt: readAckDate(body.EwbDt),
          validUpto: body.EwbValidTill ? readAckDate(body.EwbValidTill) : undefined,
          raw: body,
        };
      }
      throw refusal('did not generate the e-way bill', res, body, 'EWB_REJECTED');
    },
    async cancel(irn, { reason } = {}) {
      // "4" is Others: the reason typed here goes with it as the remark.
      const { res, body } = await callClearTax(cfg, '/einv/v1/govt/api/Cancel', { irn, CnlRsn: '4', CnlRem: String(reason || 'Cancelled').slice(0, 100) });
      if (body?.Success === 'Y') return { cancelledAt: body.CancelDate ? readAckDate(body.CancelDate) : new Date(), raw: body };
      throw refusal('refused the cancellation', res, body, 'EINVOICE_REJECTED');
    },
  }),
  'http-json': (cfg) => ({
    async register(payload) {
      const { res, body } = await callProvider(cfg, '/generate', payload);
      if (!res.ok) {
        throw failure(`The e-invoice provider answered ${res.status}${body?.message ? `: ${body.message}` : ''}.`, 'EINVOICE_REJECTED', 502);
      }
      return readRegistration(body);
    },
    /** Generate the e-way bill from a registered IRN (the portal's "EWB by IRN"). */
    async ewaybill(payload) {
      const { res, body } = await callProvider(cfg, '/ewaybill', payload, { rejected: 'EWB_REJECTED' });
      if (!res.ok) throw failure(`The e-way bill provider answered ${res.status}${body?.message ? `: ${body.message}` : ''}.`, 'EWB_REJECTED', 502);
      const data = pick(body, 'Data', 'data', 'result') && typeof pick(body, 'Data', 'data', 'result') === 'object' ? pick(body, 'Data', 'data', 'result') : body;
      const number = pick(data, 'EwbNo', 'ewbNo', 'ewayBillNo');
      if (!number) throw failure('The provider did not return an e-way bill number.', 'EWB_REJECTED', 502);
      return { number: String(number), generatedAt: readAckDate(pick(data, 'EwbDt', 'ewbDt')), validUpto: pick(data, 'EwbValidTill', 'ewbValidTill', 'validUpto') ? readAckDate(pick(data, 'EwbValidTill', 'ewbValidTill', 'validUpto')) : undefined, raw: data };
    },
    async cancel(irn, { reason }) {
      const { res, body } = await callProvider(cfg, '/cancel', { Irn: irn, CnlRsn: '1', CnlRem: String(reason || '').slice(0, 100) });
      if (!res.ok) {
        throw failure(`The e-invoice provider refused the cancellation (${res.status})${body?.message ? `: ${body.message}` : ''}.`, 'EINVOICE_REJECTED', 502);
      }
      return { cancelledAt: new Date(), raw: body };
    },
  }),
};

/** The stored GSP config, secrets included. Server-side only. */
async function loadGspConfig() {
  const row = await DocumentSettings.findOne({ key: 'document' })
    .select('gstin invoice.gsp.provider invoice.gsp.baseUrl invoice.gsp.username invoice.gsp.clientId +invoice.gsp.clientSecret +invoice.gsp.password')
    .lean();
  const g = row?.invoice?.gsp || {};
  return {
    provider: g.provider || '',
    baseUrl: g.baseUrl || '',
    username: g.username || '',
    clientId: g.clientId || '',
    clientSecret: g.clientSecret || '',
    password: g.password || '',
    gstin: row?.gstin || '',
  };
}

/** The connected provider, or a 409 that says how to connect one. */
async function getProvider() {
  const cfg = await loadGspConfig();
  if (!cfg.provider) {
    throw failure(
      'No e-invoice provider is connected. Connect a GSP in Settings → Invoice, or paste the IRN and signed QR from the portal.',
      'EINVOICE_NOT_CONFIGURED'
    );
  }
  const factory = PROVIDERS[cfg.provider];
  if (!factory) {
    throw failure(`The e-invoice provider "${cfg.provider}" is not available in this build.`, 'EINVOICE_PROVIDER_UNKNOWN');
  }
  return { name: cfg.provider, ...factory(cfg) };
}

module.exports = { getProvider, loadGspConfig, readRegistration, readAckDate, PROVIDERS, providerNames: () => Object.keys(PROVIDERS) };
