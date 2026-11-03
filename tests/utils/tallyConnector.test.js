'use strict';
// The connector reads Tally's own replies: an import's counts and error
// lines, and the ledger list with Tally's sign (a debit is negative).
const { importResult, parseLedgers, decode } = require('../../tools/tally-connector/tally-connector');

describe('reading what Tally says', () => {
  it('a voucher created, and one refused with its reason', () => {
    expect(importResult('<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>')).toMatchObject({ ok: true, created: 1 });
    const bad = importResult('<RESPONSE><LINEERROR>Ledger &apos;Sunrise&apos; does not exist!</LINEERROR><CREATED>0</CREATED><ERRORS>1</ERRORS></RESPONSE>');
    expect(bad).toMatchObject({ ok: false, errors: 1, lineErrors: ["Ledger 'Sunrise' does not exist!"] });
    expect(importResult('<RESPONSE><CANCELLED>1</CANCELLED><ERRORS>0</ERRORS></RESPONSE>').ok).toBe(true);
  });
  it('the ledger list, names decoded, balances signed as Tally keeps them', () => {
    const xml = '<ENVELOPE><LEDGER NAME="Sunrise &amp; Co" RESERVEDNAME=""><PARENT TYPE="String">Sundry Debtors</PARENT><CLOSINGBALANCE TYPE="Amount">-10,500.00</CLOSINGBALANCE><PARTYGSTIN>33AAEPS1234F1Z2</PARTYGSTIN></LEDGER><LEDGER NAME="Kotak Bank CA"><PARENT>Bank Accounts</PARENT><CLOSINGBALANCE>-100000.00</CLOSINGBALANCE></LEDGER></ENVELOPE>';
    expect(parseLedgers(xml)).toEqual([
      { name: 'Sunrise & Co', parent: 'Sundry Debtors', gstin: '33AAEPS1234F1Z2', closing: -10500 },
      { name: 'Kotak Bank CA', parent: 'Bank Accounts', gstin: '', closing: -100000 },
    ]);
    expect(decode('A &lt;B&gt; &#38; C')).toBe('A <B> & C');
  });
});
