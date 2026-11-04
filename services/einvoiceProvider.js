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
//  One adapter ships: "http-json", a plain POST of the INV-01 JSON to
//  the configured URL with the credentials as headers, taking back the
//  portal's standard field names. Most GSP proxies speak this; a
//  provider with its own handshake (a token call first, encryption)
//  gets its own factory here.
// ══════════════════════════════════════════════════════════════════

const DocumentSettings = require('../models/DocumentSettings');
const ErrorHandler = require('../utils/ErrorHandler');

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

const PROVIDERS = {
  'http-json': (cfg) => ({
    async register(payload) {
      if (!cfg.baseUrl) throw failure('The GSP has no URL in Settings → Invoice.', 'EINVOICE_NOT_CONFIGURED');
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'client-id': cfg.clientId || '',
          'client-secret': cfg.clientSecret || '',
          username: cfg.username || '',
          password: cfg.password || '',
          gstin: cfg.gstin || '',
        },
        body: JSON.stringify(payload),
      });
      let body;
      try { body = await res.json(); } catch { body = {}; }
      if (!res.ok) {
        throw failure(`The e-invoice provider answered ${res.status}${body?.message ? `: ${body.message}` : ''}.`, 'EINVOICE_REJECTED', 502);
      }
      return readRegistration(body);
    },
    /** Generate the e-way bill from a registered IRN (the portal's "EWB by IRN"). */
    async ewaybill(payload) {
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/ewaybill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'client-id': cfg.clientId || '', 'client-secret': cfg.clientSecret || '',
          username: cfg.username || '', password: cfg.password || '', gstin: cfg.gstin || '',
        },
        body: JSON.stringify(payload),
      });
      let body;
      try { body = await res.json(); } catch { body = {}; }
      if (!res.ok) throw failure(`The e-way bill provider answered ${res.status}${body?.message ? `: ${body.message}` : ''}.`, 'EWB_REJECTED', 502);
      const data = pick(body, 'Data', 'data', 'result') && typeof pick(body, 'Data', 'data', 'result') === 'object' ? pick(body, 'Data', 'data', 'result') : body;
      const number = pick(data, 'EwbNo', 'ewbNo', 'ewayBillNo');
      if (!number) throw failure('The provider did not return an e-way bill number.', 'EWB_REJECTED', 502);
      return { number: String(number), generatedAt: readAckDate(pick(data, 'EwbDt', 'ewbDt')), validUpto: pick(data, 'EwbValidTill', 'ewbValidTill', 'validUpto') ? readAckDate(pick(data, 'EwbValidTill', 'ewbValidTill', 'validUpto')) : undefined, raw: data };
    },
    async cancel(irn, { reason }) {
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'client-id': cfg.clientId || '', 'client-secret': cfg.clientSecret || '',
          username: cfg.username || '', password: cfg.password || '', gstin: cfg.gstin || '',
        },
        body: JSON.stringify({ Irn: irn, CnlRsn: '1', CnlRem: String(reason || '').slice(0, 100) }),
      });
      let body;
      try { body = await res.json(); } catch { body = {}; }
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
