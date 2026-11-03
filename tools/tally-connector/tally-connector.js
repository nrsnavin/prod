#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════
//  JARVIS → TALLY CONNECTOR
//
//  Runs on the office computer that has TallyPrime (or Tally.ERP 9)
//  open. Tally listens only on that computer (http://localhost:9000),
//  so the ERP in the cloud cannot reach it; this small program does it
//  for the ERP:
//
//    every minute   asks the ERP for the next batch queued "send
//                   through the connector", posts each voucher to Tally
//                   one at a time, and reports back which went in and
//                   which Tally refused, with Tally's own words — the
//                   refused ones go back to the ERP's queue, to send
//                   again once fixed
//    every 30 min   reads Tally's ledgers (name, group, GSTIN, closing
//                   balance) and sends them to the ERP, which compares
//                   them with its own books and lists what differs
//
//  Nothing else is read from Tally, and nothing in Tally is deleted.
//
//  ── Setting up ────────────────────────────────────────────────────
//  1. In Tally: F1 (Help) → Settings → Connectivity → Client/Server
//     configuration: "TallyPrime acts as" Both, port 9000.
//     (Tally.ERP 9: F12 → Advanced Configuration.) Keep the company open.
//  2. Install Node.js 18 or newer on that computer.
//  3. In the ERP: Accounts → Books → To Tally → Connector → "Create a
//     key". Copy it once; it is not shown again.
//  4. Next to this file, create tally-connector.json:
//       { "server": "https://erp.example.com", "key": "<the key>",
//         "tally": "http://localhost:9000" }
//     or set JARVIS_URL, JARVIS_KEY and TALLY_URL.
//  5. Run:  node tally-connector.js     (add it to Windows startup to
//     keep it running; --once sends one round and stops)
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const fileCfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'tally-connector.json'), 'utf8')); } catch { return {}; }
})();
const cfg = {
  server: String(process.env.JARVIS_URL || fileCfg.server || '').replace(/\/+$/, ''),
  key: process.env.JARVIS_KEY || fileCfg.key || '',
  tally: String(process.env.TALLY_URL || fileCfg.tally || 'http://localhost:9000').replace(/\/+$/, ''),
  everySec: Number(process.env.INTERVAL_SEC || fileCfg.intervalSec || 60),
  ledgersEveryMin: Number(process.env.LEDGERS_EVERY_MIN || fileCfg.ledgersEveryMin || 30),
};
const once = process.argv.includes('--once');

const log = (...a) => console.log(new Date().toLocaleString('en-IN'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Talking to the ERP ───────────────────────────────────────────
async function erp(method, p, body) {
  const res = await fetch(`${cfg.server}/api/v2/tally-connector${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Tally-Connector-Key': cfg.key, 'X-Connector-Version': VERSION },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`ERP ${method} ${p}: ${res.status} ${json?.message || text.slice(0, 200)}`);
  return json;
}

// ── Talking to Tally ─────────────────────────────────────────────
async function tally(xml) {
  const res = await fetch(cfg.tally, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
  const buf = Buffer.from(await res.arrayBuffer());
  // Some Tally versions answer in UTF-16.
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
}

const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : null; };
const num = (xml, name) => Number(tag(xml, name) || 0) || 0;

/** What Tally said about one import: counts, and its error lines. */
function importResult(xml) {
  const lineErrors = [...String(xml).matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => decode(m[1]));
  const r = {
    created: num(xml, 'CREATED'), altered: num(xml, 'ALTERED'), cancelled: num(xml, 'CANCELLED'), combined: num(xml, 'COMBINED'),
    ignored: num(xml, 'IGNORED'), errors: num(xml, 'ERRORS'), exceptions: num(xml, 'EXCEPTIONS'), lineErrors,
  };
  r.ok = r.errors === 0 && r.exceptions === 0 && (r.created + r.altered + r.cancelled + r.combined) > 0;
  return r;
}

const LEDGER_REQUEST = (company) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>JarvisLedgers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${company ? `<SVCURRENTCOMPANY>${company.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="JarvisLedgers" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>Name, Parent, ClosingBalance, PartyGSTIN</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

/** Every ledger: name, group, GSTIN, closing (Tally's sign: a debit is negative). */
function parseLedgers(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<LEDGER\s+NAME="([^"]*)"[^>]*>([\s\S]*?)<\/LEDGER>/gi)) {
    const body = m[2];
    const closing = Number(String(tag(body, 'CLOSINGBALANCE') || '0').replace(/,/g, '')) || 0;
    out.push({ name: decode(m[1]), parent: tag(body, 'PARENT') || '', gstin: tag(body, 'PARTYGSTIN') || '', closing });
  }
  return out;
}

// ── One round ────────────────────────────────────────────────────
let lastLedgers = 0;
let company = '';

async function round() {
  // Is Tally there?
  let tallyOk = false;
  try { await tally('<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>'); tallyOk = true; } catch (e) { log(`Tally is not answering at ${cfg.tally}: ${e.message}`); }
  const hello = await erp('POST', '/ping', { tallyOk, version: VERSION });
  company = hello.company || company;
  if (!tallyOk) return;

  // Batches queued for the connector, one at a time.
  for (let i = 0; i < 5; i++) {
    const { batch } = await erp('GET', '/next');
    if (!batch) break;
    log(`Batch ${batch.batchNo}: ${batch.messages.length} message(s) to Tally${batch.company ? ` (${batch.company})` : ''}`);
    const results = [];
    for (const msg of batch.messages) {
      try {
        const r = importResult(await tally(msg.xml));
        // A party ledger that is already there is not a failure.
        const exists = msg.kind === 'master' && !r.ok && r.lineErrors.some((e) => /already exists|duplicate/i.test(e));
        results.push({ key: msg.key, ok: r.ok || exists, error: r.ok || exists ? '' : (r.lineErrors.join(' · ') || `errors ${r.errors}, exceptions ${r.exceptions}`) });
        if (!r.ok && !exists) log(`  ✗ ${msg.number || msg.key}: ${results.at(-1).error}`);
      } catch (e) {
        results.push({ key: msg.key, ok: false, error: `Tally did not answer: ${e.message}` });
      }
    }
    const sum = await erp('POST', '/result', { batchId: batch._id, results });
    log(`  → ${sum.sent} in Tally, ${sum.failed} refused${sum.failed ? ' (back in the ERP queue)' : ''}`);
  }

  // Ledgers and balances, now and then.
  if (Date.now() - lastLedgers > cfg.ledgersEveryMin * 60_000) {
    const ledgers = parseLedgers(await tally(LEDGER_REQUEST(company)));
    if (ledgers.length) {
      // In parts: the ERP takes at most 1 MB a request.
      let snapshot = null;
      for (let i = 0; i < ledgers.length; i += 2000) {
        const r = await erp('POST', '/ledgers', { company, ledgers: ledgers.slice(i, i + 2000), ...(snapshot ? { snapshot } : {}) });
        snapshot = r.snapshot;
      }
      log(`Sent ${ledgers.length} ledgers and their balances for comparison`);
    } else {
      log('Tally returned no ledgers — is the company open?');
    }
    lastLedgers = Date.now();
  }
}

async function main() {
  if (!cfg.server || !cfg.key) {
    console.error('Set "server" and "key" in tally-connector.json (or JARVIS_URL and JARVIS_KEY).');
    process.exit(2);
  }
  if (typeof fetch !== 'function') {
    console.error('Node.js 18 or newer is needed.');
    process.exit(2);
  }
  log(`Jarvis → Tally connector ${VERSION}: ERP ${cfg.server}, Tally ${cfg.tally}`);
  do {
    try { await round(); } catch (e) { log(e.message); }
    if (!once) await sleep(cfg.everySec * 1000);
  } while (!once);
}

if (require.main === module) main();
module.exports = { importResult, parseLedgers, LEDGER_REQUEST, decode };
