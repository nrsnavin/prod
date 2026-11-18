'use strict';
// ══════════════════════════════════════════════════════════════════
//  A GSTIN, CHECKED WITH THE GST SYSTEM
//
//  "Verify" beside the GSTIN on a customer or supplier form. Two checks,
//  in this order:
//
//    1. Here, with no call to anyone: fifteen characters in the right
//       pattern, and the last one is the check character of the other
//       fourteen. A number that fails this cannot exist, so it is never
//       sent out — a typo is caught for free.
//
//    2. With the GST system: is it registered, to whom, where, and is it
//       still active. The answer fills the form — name, address, city,
//       PIN, state — and says so if the registration was cancelled.
//
//  ── Who is asked ───────────────────────────────────────────────────
//  The GST portal's own search is a web page behind a captcha; it has no
//  door a server may knock on. The lookup is a call licensed providers
//  make. In order:
//
//    a. A GSTIN lookup service named in Settings → Invoice, when there
//       is one: an address with {gstin} in it, and its key.
//    b. The e-invoice provider already connected there. ClearTax answers
//       the e-invoice system's "Get GSTIN details"; a GSP proxy
//       ("http-json") is asked at {its address}/gstin/{gstin}.
//    c. Nobody: the first check still runs, and the answer says how to
//       connect one.
//
//  ── Two layouts, many spellings, one reading ───────────────────────
//  Providers hand back one of two layouts, sometimes wrapped in "data"
//  or "result":
//
//    the e-invoice system's   Gstin, LegalName, TradeName, AddrBno,
//                             AddrFlno, AddrBnm, AddrSt, AddrLoc,
//                             AddrPncd, StateCode, TxpType, Status (ACT,
//                             CNL…), BlkStatus, DtReg, DtDReg
//    the common portal's      gstin, lgnm, tradeNam, sts, dty, ctb, rgdt,
//                             cxdt, pradr.addr { bno, flno, bnm, st, loc,
//                             dst, city, stcd, pncd }
//
//  and each provider spells the first its own way ("legalName",
//  "legal_name"). normalise() reads any of them into one record — keys
//  are matched with their case and punctuation set aside — so a change
//  of provider is a change in Settings and not here.
//
//  ── Kept ───────────────────────────────────────────────────────────
//  Every answer is kept (models/GstinCheck.js), one row per GSTIN. A
//  second click within FRESH_MS is answered from it: each call to a
//  provider is a call somebody pays for.
// ══════════════════════════════════════════════════════════════════

const DocumentSettings = require('../models/DocumentSettings');
const GstinCheck = require('../models/GstinCheck');
const ErrorHandler = require('../utils/ErrorHandler');
const { outboundUrlProblem } = require('../utils/outboundUrl');
const { gstinInfo } = require('../utils/partyCardOcr');
const { STATE_NAMES } = require('./gst');
const { loadGspConfig, PROVIDERS, clearTaxErrors } = require('./einvoiceProvider');

/** A check this recent answers the next click without asking again. */
const FRESH_MS = 15 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 20_000;
const LOOKUP_MAX_BYTES = 1024 * 1024;

const failure = (message, code, status = 502) => {
  const err = new ErrorHandler(message, status);
  err.code = code;
  return err;
};

const str = (v, n = 200) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n));
const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();

// ── 1. The check made here ────────────────────────────────────────

/** The GSTIN as written, and what its own characters say. */
function local(raw) {
  const gstin = String(raw || '').replace(/\s+/g, '').toUpperCase();
  const info = gstinInfo(gstin);
  return {
    gstin,
    valid: info.valid,
    checksumOk: info.checksumOk,
    stateCode: info.stateCode,
    stateName: STATE_NAMES[info.stateCode] || '',
    pan: info.pan,
  };
}

// ── 2. Reading a provider's answer ────────────────────────────────

/** A calendar date however it was written, as YYYY-MM-DD; '' for none. */
function day(v) {
  const s = str(v, 30);
  let y, m, d;
  let hit = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (hit) [, y, m, d] = hit;
  else if ((hit = /^(\d{2})[/-](\d{2})[/-](\d{4})/.exec(s))) [, d, m, y] = hit;
  else return '';
  // The e-invoice system writes "no such date" as 1900-01-01.
  if (Number(y) < 1950 || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return `${y}-${m}-${d}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2024-03-12" → "12 Mar 2024". */
const nice = (ymd) => (ymd ? `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}` : '');

const NIC_STATUS = { ACT: 'active', CNL: 'cancelled', INA: 'inactive', PRO: 'provisional', SUS: 'suspended' };
const STATUS_TEXT = {
  active: 'Active', cancelled: 'Cancelled', suspended: 'Suspended',
  inactive: 'Inactive', provisional: 'Provisional', unknown: 'Status not given',
};

function statusOf(raw) {
  const t = str(raw, 40);
  if (!t) return 'unknown';
  if (NIC_STATUS[t.toUpperCase()]) return NIC_STATUS[t.toUpperCase()];
  if (/^act/i.test(t)) return 'active';
  if (/cancel/i.test(t)) return 'cancelled';
  if (/suspend/i.test(t)) return 'suspended';
  if (/inact/i.test(t)) return 'inactive';
  if (/provis/i.test(t)) return 'provisional';
  return 'unknown';
}

// The e-invoice system's codes; the common portal writes the words.
const NIC_TYPES = {
  REG: 'Regular', COM: 'Composition', SEZ: 'SEZ unit', SED: 'SEZ developer',
  ISD: 'Input service distributor', TDS: 'Tax deductor', TCS: 'Tax collector',
  UNB: 'UN body', EMB: 'Embassy', CTP: 'Casual taxable person', NRT: 'Non-resident taxable person',
};
const typeOf = (raw) => { const t = str(raw, 60); return NIC_TYPES[t.toUpperCase()] || t; };

// ── Finding the registration in a reply ───────────────────────────
// Providers agree on what a registration holds and not on how to spell
// it: "LegalName", "legalName", "legal_name" and "lgnm" are one field.
// Keys are compared with their case and punctuation set aside, and each
// field is looked for under every name it is known to go by.

const bare = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** An object's values under its keys' bare spelling. */
function fields(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    const b = bare(k);
    if (b && !(b in out)) out[b] = v;
  }
  // "address_building_number" and "AddrBno" are the building number:
  // also kept under what follows the "address" / "addr".
  for (const [b, v] of Object.entries(out)) {
    const rest = b.startsWith('address') ? b.slice(7) : b.startsWith('addr') ? b.slice(4) : '';
    if (rest && !(rest in out)) out[rest] = v;
  }
  return out;
}

/** The first of `names` that holds something. */
const first = (f, ...names) => {
  for (const n of names) {
    const v = f[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const NAMES = {
  gstin: ['gstin', 'gstinuin', 'gstinno', 'gstnumber'],
  legalName: ['legalname', 'lgnm', 'legalnameofbusiness', 'lglnm'],
  tradeName: ['tradename', 'tradenam', 'tradenameofbusiness', 'trdnm'],
  status: ['status', 'sts', 'gstinstatus', 'taxpayerstatus'],
  type: ['txptype', 'taxpayertype', 'dty', 'dealertype', 'registrationtype'],
  blocked: ['blkstatus', 'blockstatus', 'einvoiceblockstatus'],
  registered: ['dtreg', 'rgdt', 'dateofregistration', 'registrationdate'],
  cancelled: ['dtdreg', 'cxdt', 'dateofderegistration', 'deregistrationdate', 'dateofcancellation', 'cancellationdate'],
  // The address, wherever it sits: on the registration itself (the
  // e-invoice system) or in "pradr.addr" (the common portal).
  bno: ['addrbno', 'bno', 'buildingnumber', 'buildingno', 'doornumber', 'doorno'],
  flno: ['addrflno', 'flno', 'floornumber', 'floorno', 'floor'],
  bnm: ['addrbnm', 'bnm', 'buildingname', 'bname'],
  st: ['addrst', 'st', 'street', 'road'],
  loc: ['addrloc', 'loc', 'location', 'locality'],
  dst: ['dst', 'district'],
  city: ['city'],
  pncd: ['addrpncd', 'pncd', 'pincode', 'pin', 'postalcode'],
  stateName: ['stcd', 'statename', 'state'],
  // The whole address as one piece of text, where that is all there is.
  whole: ['adr', 'fulladdress', 'principaladdress', 'principalplaceofbusiness', 'principalplaceaddress', 'registeredaddress', 'address'],
};

// Where a reply keeps the address when it is a block of its own. "adress"
// is one lookup service's own spelling.
const ADDRESS_BLOCKS = ['address', 'adress', 'addr', 'principaladdress', 'registeredaddress'];

/** It names who it is registered to: a registration, whatever else it holds. */
const hasName = (f) => first(f, ...NAMES.legalName, ...NAMES.tradeName) !== undefined || (f.pradr && typeof f.pradr === 'object');
/** A GSTIN with a status or a PIN beside it: probably one — unless what it wraps is. */
const hasGstinAndMore = (f) => first(f, ...NAMES.gstin) !== undefined && first(f, ...NAMES.status, ...NAMES.pncd) !== undefined;

const WRAPPERS = ['data', 'result', 'results', 'taxpayerinfo', 'taxpayer', 'taxpayerdetails', 'gstindetails', 'details', 'response', 'payload', 'body'];

/** The object in the reply that is the registration, wherever it was put. */
function findTaxpayer(body, depth = 0) {
  let o = body;
  if (typeof o === 'string') {
    // Some proxies hand "Data" back as a string of JSON.
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o)) {
    for (const x of o.slice(0, 3)) {
      const t = findTaxpayer(x, depth + 1);
      if (t) return t;
    }
    return null;
  }
  const f = fields(o);
  if (hasName(f)) return f;
  // An envelope that repeats the GSTIN and a status of its own
  // ("status": "success") around the registration: what it wraps wins.
  if (depth < 3) {
    for (const k of WRAPPERS) {
      if (f[k] != null) {
        const t = findTaxpayer(f[k], depth + 1);
        if (t) return t;
      }
    }
  }
  return hasGstinAndMore(f) ? f : null;
}

/** The registered address as the form's fields: street, town, PIN, state. */
function addressOf(a, stateCode) {
  const parts = [];
  for (const p of [first(a, ...NAMES.bno), first(a, ...NAMES.flno), first(a, ...NAMES.bnm), first(a, ...NAMES.st)]) {
    const v = str(p, 120);
    // A building name repeated as the street is said once.
    if (v && !parts.some((x) => same(x, v))) parts.push(v);
  }
  // No parts at all, but the address as one piece of text: that is the line.
  if (!parts.length) {
    const whole = NAMES.whole.map((n) => a[n]).find((v) => typeof v === 'string' && v.trim());
    if (whole) parts.push(str(whole, 240));
  }
  const locality = str(first(a, ...NAMES.loc), 80);
  const district = str(first(a, ...NAMES.dst), 80);
  const city = str(first(a, ...NAMES.city), 80) || district || locality;
  const pin = String(first(a, ...NAMES.pncd) ?? '').replace(/\D/g, '');
  // What the reply calls the state, when the GSTIN's own digits name none.
  const said = first(a, ...NAMES.stateName);
  return {
    line: parts.join(', '),
    locality: locality && !same(locality, city) ? locality : '',
    city,
    district: district && !same(district, city) ? district : '',
    state: STATE_NAMES[stateCode] || (typeof said === 'string' && !/^\d+$/.test(said.trim()) ? str(said, 60) : ''),
    stateCode,
    pincode: /^\d{6}$/.test(pin) ? pin : '',
  };
}

/**
 * A provider's reply as one record, or null when it carries no taxpayer.
 * @param {*} body what the provider sent (object, array or JSON string)
 * @param {string} asked the GSTIN that was asked about
 */
function normalise(body, asked = '') {
  const f = findTaxpayer(body);
  if (!f) return null;
  const gstin = str(first(f, ...NAMES.gstin), 20).toUpperCase() || String(asked || '').toUpperCase();
  // The state a GSTIN is registered in is its first two digits.
  const stateCode = /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : '';
  const taxpayerType = typeOf(first(f, ...NAMES.type));
  const blk = str(first(f, ...NAMES.blocked), 12).toUpperCase();
  // The common portal nests the address; the e-invoice system does not.
  const pradr = f.pradr && typeof f.pradr === 'object' ? fields(f.pradr) : null;
  const block = ADDRESS_BLOCKS.map((k) => f[k]).find((v) => v && typeof v === 'object' && !Array.isArray(v));
  const nested = pradr ? (pradr.addr && typeof pradr.addr === 'object' ? { ...pradr, ...fields(pradr.addr) } : pradr)
    : (block ? fields(block) : null);
  return {
    gstin,
    legalName: str(first(f, ...NAMES.legalName), 160),
    tradeName: str(first(f, ...NAMES.tradeName), 160),
    status: statusOf(first(f, ...NAMES.status)),
    taxpayerType,
    composition: /compos/i.test(taxpayerType),
    sez: /\bsez\b/i.test(taxpayerType),
    registeredOn: day(first(f, ...NAMES.registered)),
    cancelledOn: day(first(f, ...NAMES.cancelled)),
    // Only the e-invoice system says whether it may be invoiced; unsaid is not "no".
    einvoiceBlocked: /^(B|BLOCKED|Y|YES|TRUE)$/.test(blk) ? true : /^(U|UNBLOCKED|N|NO|FALSE)$/.test(blk) ? false : null,
    address: addressOf(nested || f, stateCode),
  };
}

// ── 3. Who is asked ───────────────────────────────────────────────

const LABELS = { cleartax: 'ClearTax', 'http-json': 'your e-invoice provider', lookup: 'your GSTIN lookup service' };

/** The lookup service in Settings → Invoice, its key included. Server-side only. */
async function loadLookupConfig() {
  const row = await DocumentSettings.findOne({ key: 'document' })
    .select('invoice.gstinLookup.url invoice.gstinLookup.headerName +invoice.gstinLookup.key')
    .lean();
  const l = row?.invoice?.gstinLookup || {};
  return { url: l.url || '', headerName: l.headerName || '', key: l.key || '' };
}

/** Who answers a lookup: { kind, label, call(gstin) → { res, body } }, or null. */
async function source() {
  const lk = await loadLookupConfig();
  if (lk.url) return { kind: 'lookup', label: LABELS.lookup, call: (gstin) => callLookup(lk, gstin) };
  const cfg = await loadGspConfig();
  const factory = cfg.provider ? PROVIDERS[cfg.provider] : null;
  const provider = factory ? factory(cfg) : null;
  // A provider that is named but has no credentials yet is not a
  // connection: the form is told how to make one, not shown an error.
  const connected = cfg.provider === 'cleartax' ? !!cfg.clientSecret : !!(cfg.baseUrl && (cfg.clientSecret || cfg.password));
  if (provider && connected && typeof provider.gstinDetails === 'function') {
    return { kind: cfg.provider, label: LABELS[cfg.provider] || 'your e-invoice provider', call: (gstin) => provider.gstinDetails(gstin) };
  }
  return null;
}

/** Whether "Verify" can ask the GST system, and through whom. For the forms. */
async function availability() {
  const src = await source();
  return src ? { available: true, via: src.label } : { available: false, via: '' };
}

/**
 * GET the lookup service's address, {gstin} (and {key}, when the key
 * goes in the address) filled in; the key as a header when one is named.
 */
async function callLookup(lk, gstin) {
  const url = lk.url.split('{gstin}').join(encodeURIComponent(gstin)).split('{key}').join(encodeURIComponent(lk.key || ''));
  // Checked when it is saved too; this covers one stored before that.
  const problem = outboundUrlProblem(url);
  if (problem) throw failure(`The GSTIN lookup address in Settings → Invoice cannot be used: ${problem}.`, 'GSTIN_LOOKUP_NOT_CONFIGURED', 409);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(lk.headerName && lk.key ? { [lk.headerName]: lk.key } : {}) },
      redirect: 'error', // the key goes to the address in Settings, nowhere it points on to
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (err) {
    const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw failure(
      slow ? 'The GSTIN lookup service did not answer in time. Try again in a minute.'
           : 'The GSTIN lookup service could not be reached. Try again in a minute.',
      'GSTIN_LOOKUP_FAILED'
    );
  }
  // A registration is a page of text. Something that announces itself
  // as megabytes is not one, and is not read into memory to find out.
  if (Number(res.headers?.get?.('content-length')) > LOOKUP_MAX_BYTES) {
    throw failure('The GSTIN lookup service sent back far more than a registration. Check its address in Settings → Invoice.', 'GSTIN_LOOKUP_FAILED');
  }
  let body;
  try { body = await res.json(); } catch { body = {}; }
  return { res, body };
}

/** What the provider said when it sent no taxpayer: its codes and words. */
function saidBy(body) {
  const b = body && typeof body === 'object' ? body : {};
  return str(
    clearTaxErrors(b)
      || b.errorMessage || b.error_description || b.status_desc || b.statusMessage
      || (typeof b.error === 'string' ? b.error : b.error?.message)
      || (typeof b.Data === 'string' && !/^[[{]/.test(b.Data.trim()) ? b.Data : ''),
    280
  );
}

// What a provider says when the answer is about the NUMBER — there is no
// such registration, or it is not a live one — as against about the call
// (a bad token, a quota, a workspace that is not set up). Only the first
// may be shown as "no registration came back": told that a good number
// does not exist because a token had expired, somebody would turn a real
// customer away. The e-invoice system's codes (3001 no data, 3028/3030
// invalid GSTIN, 3029 not active, 3074–3078 cancelled or inactive), the
// common portal's (FO8000 no records, SWEB_9035 invalid GSTIN), and the
// words lookup services use.
const ABOUT_THE_NUMBER = new RegExp([
  '\\b(3001|3028|3029|3030|307[4-8]|FO8000|SWEB_9035)\\b',
  'no records? (?:were |was |is )?found',
  'records? (?:not|could not be) found',
  'no (?:such )?(?:gstin|taxpayer|data|details?)(?: (?:is|was|were))? (?:found|available|exists?)',
  '(?:gstin|gst number|gst no|taxpayer|requested data|data|details?)[^.;:]{0,40}(?:not found|not available|does not exist|doesn\'t exist|is invalid|is not valid|not valid|invalid|not active|inactive|cancell?ed|suspended)',
  'invalid (?:gstin|gst number|gst no)',
].join('|'), 'i');

/** The reply as { found, details } or { found: false, said }; throws when the provider failed. */
function read(src, res, body, gstin) {
  const details = normalise(body, gstin);
  if (details) {
    if (details.gstin !== gstin) {
      throw failure(`${cap(src.label)} answered about ${details.gstin}, not ${gstin}. Nothing was filled in.`, 'GSTIN_LOOKUP_FAILED');
    }
    return { found: true, details };
  }
  const said = saidBy(body);
  const status = Number(res?.status) || 0;
  if (status === 401 || status === 403) {
    throw failure(`${cap(src.label)} refused the GSTIN lookup (${status})${said ? `: ${said}` : ''}. Check the connection in Settings → Invoice.`, 'GSTIN_LOOKUP_REFUSED');
  }
  if (status === 429) throw failure(`${cap(src.label)} is taking no more GSTIN lookups for now${said ? `: ${said}` : ''}. Try again later.`, 'GSTIN_LOOKUP_FAILED');
  if (status >= 500) throw failure(`${cap(src.label)} could not look the GSTIN up just now (${status}). Try again in a minute.`, 'GSTIN_LOOKUP_FAILED');
  // It was asked, and its answer is about this number.
  if (said && ABOUT_THE_NUMBER.test(said)) return { found: false, said };
  // It said something else: about the call, not the number.
  if (said) {
    throw failure(`${cap(src.label)} did not look the GSTIN up${status && status !== 200 ? ` (${status})` : ''}: ${said}`, 'GSTIN_LOOKUP_FAILED');
  }
  if (status === 404 || status === 405) {
    // Nothing at that address at all — not an answer about the GSTIN.
    throw failure(
      src.kind === 'lookup'
        ? `Nothing answers at the GSTIN lookup address in Settings → Invoice (${status}).`
        : `${cap(src.label)} has no GSTIN lookup on this connection (${status}). A GSTIN lookup service can be named in Settings → Invoice instead.`,
      'GSTIN_LOOKUP_UNAVAILABLE'
    );
  }
  // An answer with no registration in it and no word of why: not one to
  // read "no such GSTIN" into.
  throw failure(`${cap(src.label)} sent back nothing that reads as a GST registration. Nothing was filled in.`, 'GSTIN_LOOKUP_FAILED');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ── 4. The answer ─────────────────────────────────────────────────

/** Both names, said once when they are the same. */
function whoIs(row) {
  if (row.legalName && row.tradeName && !same(row.legalName, row.tradeName)) return `${row.legalName} (trade name ${row.tradeName})`;
  return row.legalName || row.tradeName || 'the name was not given';
}

/** One line for the form: what the GST system said. */
function messageFor(row) {
  // The provider's own words, not "it does not exist": the same answer
  // comes back for a number that was never issued and one that is no
  // longer live.
  if (!row.found) return `No registration came back for ${row.gstin} from the GST portal${row.said ? ` — it said: ${row.said}` : ''}`.replace(/[.\s]+$/, '') + '.';
  const who = whoIs(row);
  switch (row.status) {
    case 'active': return `Active on the GST portal: ${who}.`;
    case 'cancelled': return `Cancelled on the GST portal${row.cancelledOn ? ` since ${nice(row.cancelledOn)}` : ''}: ${who}. It is no longer a registered party.`;
    case 'suspended': return `Suspended on the GST portal: ${who}. Check with them before billing or buying on this number.`;
    case 'inactive': return `Inactive on the GST portal: ${who}.`;
    case 'provisional': return `Provisionally registered on the GST portal: ${who}.`;
    default: return `On the GST portal: ${who}. Its status was not given.`;
  }
}

/** What a customer or supplier form can take from the registration. */
function fillFrom(row) {
  if (!row.found) return null;
  const a = row.address || {};
  const street = [a.line, a.locality].filter(Boolean).join(', ');
  // The town, state and PIN are added to the one-line address only where
  // the line does not already say them (an address that came as one
  // piece of text usually does). Said, that is, as a part of its own:
  // "Avinashi Road" does not say the town is Avinashi.
  const said = street.split(/,|\s-\s|\n/).map((x) => x.trim()).filter(Boolean);
  const has = (piece) => !!piece && said.some((x) => same(x, piece));
  const tail = [has(a.state) ? '' : a.state, has(a.pincode) ? '' : a.pincode].filter(Boolean).join(' - ');
  return {
    // What the business is known by; the legal name beside it to choose.
    name: row.tradeName || row.legalName,
    legalName: row.legalName,
    tradeName: row.tradeName,
    address: street,
    city: a.city || '',
    pincode: a.pincode || '',
    stateCode: a.stateCode || row.gstin.slice(0, 2),
    // The whole address on one line, for a form that has one address field.
    fullAddress: [street, has(a.city) ? '' : a.city, has(a.district) ? '' : a.district, tail].filter(Boolean).join(', '),
    pan: row.gstin.slice(2, 12),
    gstRegistration: row.composition ? 'composition' : 'regular',
    sez: !!row.sez,
  };
}

/** The portal's half of an answer, from a kept row. */
function portalOf(row, { fromCache }) {
  return {
    checked: true,
    found: !!row.found,
    fromCache,
    checkedAt: row.checkedAt,
    checkedByName: row.checkedByName || '',
    source: row.source,
    via: LABELS[row.source] || '',
    said: row.said || '',
    status: row.status,
    statusText: STATUS_TEXT[row.status] || STATUS_TEXT.unknown,
    legalName: row.legalName || '',
    tradeName: row.tradeName || '',
    taxpayerType: row.taxpayerType || '',
    composition: !!row.composition,
    sez: !!row.sez,
    registeredOn: row.registeredOn || '',
    cancelledOn: row.cancelledOn || '',
    einvoiceBlocked: row.einvoiceBlocked ?? null,
    address: row.address || {},
  };
}

const answer = (info, row, o) => ({ ...info, portal: portalOf(row, o), fill: fillFrom(row), message: messageFor(row) });

/**
 * Check a GSTIN: here first, then with the GST system.
 * @param {string} raw the GSTIN as typed
 * @param {{ user?: object|null, fresh?: boolean }} [o] fresh: ask again
 *        even when a recent answer is kept
 */
async function verify(raw, { user = null, fresh = false } = {}) {
  const info = local(raw);
  if (!info.valid) throw new ErrorHandler('That is not a GSTIN: 15 characters, like 33AAECS1234F1Z5.', 400);
  if (!info.checksumOk) {
    return {
      ...info, portal: { checked: false, reason: 'checksum' }, fill: null,
      message: 'The last character does not match the rest of the number — check for a typo. It was not sent to the GST portal.',
    };
  }
  const src = await source();
  if (!src) {
    return {
      ...info, portal: { checked: false, reason: 'not_connected' }, fill: null,
      message: `The number is well-formed (${info.stateName || `state ${info.stateCode}`}, PAN ${info.pan}). `
        + 'Checking it with the GST portal needs a connection: ClearTax or a GSTIN lookup service, in Settings → Invoice.',
    };
  }
  if (!fresh) {
    const kept = await GstinCheck.findOne({ gstin: info.gstin, checkedAt: { $gte: new Date(Date.now() - FRESH_MS) } }).lean();
    if (kept) return answer(info, kept, { fromCache: true });
  }

  const { res, body } = await src.call(info.gstin);
  const got = read(src, res, body, info.gstin);
  const d = got.details || {};
  const row = await GstinCheck.findOneAndUpdate(
    { gstin: info.gstin },
    {
      $set: {
        found: got.found,
        said: got.found ? '' : (got.said || ''),
        status: got.found ? d.status : 'unknown',
        statusText: got.found ? STATUS_TEXT[d.status] : '',
        legalName: d.legalName || '',
        tradeName: d.tradeName || '',
        taxpayerType: d.taxpayerType || '',
        composition: !!d.composition,
        sez: !!d.sez,
        registeredOn: d.registeredOn || '',
        cancelledOn: d.cancelledOn || '',
        einvoiceBlocked: d.einvoiceBlocked ?? null,
        address: d.address || { line: '', locality: '', city: '', district: '', state: '', stateCode: '', pincode: '' },
        source: src.kind,
        checkedAt: new Date(),
        checkedBy: user?._id ?? null,
        checkedByName: user?.name || '',
      },
      $setOnInsert: { gstin: info.gstin },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return answer(info, row, { fromCache: false });
}

/** The last answer kept for a GSTIN, whatever its age; null when never checked. */
async function lastCheck(raw) {
  const info = local(raw);
  if (!info.valid) return null;
  const row = await GstinCheck.findOne({ gstin: info.gstin }).lean();
  return row ? answer(info, row, { fromCache: true }) : null;
}

module.exports = { verify, lastCheck, availability, normalise, local, messageFor, fillFrom, FRESH_MS };
