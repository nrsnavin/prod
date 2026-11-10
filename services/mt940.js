'use strict';
// ══════════════════════════════════════════════════════════════════
//  MT940 — THE BANKS' END-OF-DAY STATEMENT FORMAT
//
//  The SWIFT customer statement a bank's cash-management desk sends
//  (by SFTP, usually after the day's cut-off). One file can hold
//  several statements, one per account and day:
//
//    :20:  transaction reference         :25:  account (BANKCODE/NUMBER)
//    :28C: statement / sequence number   :60F: opening balance (60M mid-way)
//    :61:  one transaction               :86:  its narration
//    :62F: closing balance (62M mid-way) :64:  closing available balance
//
//  :61: reads  YYMMDD [MMDD] (C|D|RC|RD) [funds] amount type ref [//bankref]
//  e.g.        2610011001C10500,00NTRFINV0701//KKBK2610011234
//  RC/RD are reversals: a reversed credit takes money out, and so on.
//
//  The rows come out as the CSV parser's do, with the running balance
//  worked back from the closing balance (or forward from the opening),
//  so the rest of the import cannot tell how the statement arrived.
// ══════════════════════════════════════════════════════════════════

const { r2 } = require('../utils/money');

/** Does this text look like MT940? */
function isMt940(text) {
  const t = String(text || '');
  return /(^|\n)\s*:20:/.test(t) && /(^|\n)\s*:25:/.test(t) && /(^|\n)\s*:61:/.test(t);
}

const amountOf = (s) => Number(String(s || '0').replace(',', '.'));

function dateOf(yymmdd) {
  const m = String(yymmdd || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(2000 + +m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

/** :60F: / :62F: / :64:  →  C|D YYMMDD CUR amount */
function balanceOf(v) {
  const m = String(v || '').replace(/\s+/g, '').match(/^([CD])(\d{6})([A-Z]{3})([\d,]+)$/);
  if (!m) return null;
  return { amount: r2(amountOf(m[4]) * (m[1] === 'D' ? -1 : 1)), date: dateOf(m[2]), currency: m[3] };
}

/** The tagged fields of one message, continuation lines joined to their field. */
function fieldsOf(body) {
  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (m) out.push({ tag: m[1], value: m[2] });
    else if (out.length && line.trim() && line.trim() !== '-') out[out.length - 1].value += `\n${line}`;
  }
  return out;
}

/** :86: free text, flattened; the ?NN subfield codes some banks use are dropped. */
const narrationOf = (v) => String(v || '').replace(/\?\d{2}/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();

function transactionOf(v) {
  const [first, ...rest] = String(v || '').split('\n');
  const m = first.match(/^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d[\d,]*)([A-Z][A-Z0-9]{3})(.*)$/);
  if (!m) return null;
  const valueDate = dateOf(m[1]);
  if (!valueDate) return null;
  // The booking date (MMDD) is the date the bank's own CSV shows; its year
  // is the value date's, give or take the turn of the year.
  let date = valueDate;
  if (m[2]) {
    const month = +m[2].slice(0, 2) - 1;
    const day = +m[2].slice(2);
    let year = valueDate.getFullYear();
    if (valueDate.getMonth() === 11 && month === 0) year += 1;
    else if (valueDate.getMonth() === 0 && month === 11) year -= 1;
    const d = new Date(year, month, day);
    if (d.getMonth() === month) date = d;
  }
  const mark = m[3];
  const direction = mark === 'C' || mark === 'RD' ? 'in' : 'out';
  const [customerRef, bankRef = ''] = m[7].split('//');
  return {
    date, direction, amount: r2(amountOf(m[5])), type: m[6], reversal: mark.startsWith('R'),
    customerRef: customerRef.trim(), bankRef: bankRef.trim(), details: rest.join(' ').trim(),
  };
}

/** The account number in :25: — "KKBKINBB/1234567890" or "1234567890". */
const accountNoOf = (v) => {
  const last = String(v || '').split('\n')[0].split('/').pop().trim();
  return last.replace(/[^0-9A-Za-z]/g, '');
};

/**
 * @returns [{ account, reference, sequence, opening, closing, closingAvailable, rows }]
 *          rows as bankStatement.parse() gives them.
 */
function parseMt940(text) {
  // SWIFT envelopes ({1:…}{2:…}{4: … -}) are unwrapped; the text block is what matters.
  const body = String(text || '').replace(/^﻿/, '').replace(/\{[1235]:[^{}]*\}/g, '').replace(/\{4:/g, '\n').replace(/\n-\}/g, '\n');
  const messages = body.split(/(?=^\s*:20:)/m).filter((m) => /:61:|:60[FM]:|:62[FM]:/.test(m));
  const out = [];
  for (const msg of messages) {
    const f = fieldsOf(msg.trim());
    const st = { account: '', reference: '', sequence: '', opening: null, closing: null, closingAvailable: null, rows: [] };
    let last = null;
    for (const { tag, value } of f) {
      if (tag === '20') st.reference = value.trim();
      else if (tag === '25') st.account = accountNoOf(value);
      else if (tag === '28C' || tag === '28') st.sequence = value.trim();
      else if (tag === '60F' || tag === '60M') st.opening = balanceOf(value);
      else if (tag === '62F' || tag === '62M') st.closing = balanceOf(value);
      else if (tag === '64') st.closingAvailable = balanceOf(value);
      else if (tag === '61') {
        const t = transactionOf(value);
        last = t ? { ...t, narration: '' } : null;
        if (last && last.amount > 0) st.rows.push(last);
      } else if (tag === '86' && last) last.narration = narrationOf(value);
    }
    // Running balance: back from the closing (what the bank says it is now),
    // or forward from the opening.
    const signed = st.rows.map((r) => (r.direction === 'in' ? r.amount : -r.amount));
    const bal = new Array(st.rows.length).fill(null);
    if (st.closing) {
      let b = st.closing.amount;
      for (let i = st.rows.length - 1; i >= 0; i--) { bal[i] = r2(b); b -= signed[i]; }
    } else if (st.opening) {
      let b = st.opening.amount;
      for (let i = 0; i < st.rows.length; i++) { b += signed[i]; bal[i] = r2(b); }
    }
    st.rows = st.rows.map((r, i) => {
      const ref = r.customerRef && r.customerRef.toUpperCase() !== 'NONREF' ? r.customerRef : r.bankRef;
      const narration = (r.narration || r.details || [r.customerRef, r.bankRef].filter(Boolean).join(' ') || r.type).slice(0, 300);
      return { date: r.date, narration: r.reversal ? `REVERSAL ${narration}`.slice(0, 300) : narration, ref: String(ref || '').slice(0, 60), amount: r.amount, direction: r.direction, balance: bal[i] };
    });
    out.push(st);
  }
  return out;
}

module.exports = { isMt940, parseMt940, transactionOf, balanceOf, accountNoOf };
