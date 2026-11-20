'use strict';
// Reading a bank's statement file (services/bankStatement.js):
//
//  · An overdrawn balance. A cash-credit or overdraft account's balance is
//    marked "Dr" — on the figure itself, or in a column of its own (Kotak
//    writes two "Dr / Cr" columns, one for the amount and one for the
//    balance). The mark was dropped and the figure kept: ₹2,20,000 owed to
//    the bank was read as ₹2,20,000 in it, the next statement's opening
//    balance "did not carry over" every week, and the reconciliation
//    started from a bank balance of the wrong sign.
//  · An amount marked "Dr" in its own cell, with no column to say so, was
//    money in.
//  · A date that does not exist — or one written month first — was rolled
//    into another month ("11/20/2026" became 11 August 2027), and a line
//    whose date could not be read at all was left out without a word.
//  · A one-day statement written newest first was read oldest first, so
//    its opening and closing balances were the wrong ends.

const bank = require('../../services/bankStatement');

const csv = (lines) => Buffer.from(lines.join('\n'), 'utf8');
const read = (lines) => bank.parse(csv(lines), 'text/csv', 'statement.csv');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('an overdrawn balance', () => {
  it('is below zero when the balance has a Dr / Cr column of its own', async () => {
    const rows = await read([
      'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
      '1,02/11/2026,02/11/2026,NEFT SUNRISE GARMENTS,N123,"50,000.00",CR,"1,50,000.00",DR',
      '2,03/11/2026,03/11/2026,RTGS SRI YARN,R456,"70,000.00",DR,"2,20,000.00",DR',
      '3,04/11/2026,04/11/2026,NEFT KUMAR KNITS,N789,"3,00,000.00",CR,"80,000.00",CR',
    ]);
    expect(rows.map((r) => [r.direction, r.amount, r.balance])).toEqual([['in', 50000, -150000], ['out', 70000, -220000], ['in', 300000, 80000]]);
    expect(bank.openingOf(rows)).toBe(-200000);
    expect(bank.closingOf(rows)).toBe(80000);
  });

  it('is below zero when the figure itself says Dr', async () => {
    const rows = await read([
      'Date,Narration,Withdrawal,Deposit,Balance',
      '02/11/2026,NEFT A,,"50,000.00","1,50,000.00 Dr"',
      '03/11/2026,RTGS B,"70,000.00",,"2,20,000.00Dr."',
      '04/11/2026,NEFT C,"3,00,000.00",,"(5,20,000.00)"',
      '05/11/2026,NEFT D,,"6,00,000.00","80,000.00 Cr"',
    ]);
    expect(rows.map((r) => r.balance)).toEqual([-150000, -220000, -520000, 80000]);
  });

  it('an account in funds reads as before', async () => {
    const rows = await read([
      'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Amount,Dr / Cr,Balance,Dr / Cr',
      '1,02/11/2026,02/11/2026,NEFT SUNRISE GARMENTS,N123,"50,000.00",CR,"1,50,000.00",CR',
      '2,03/11/2026,03/11/2026,RTGS SRI YARN,R456,"70,000.00",DR,"80,000.00",CR',
    ]);
    expect(rows.map((r) => r.balance)).toEqual([150000, 80000]);
    expect(bank.openingOf(rows)).toBe(100000);
  });
});

describe('an amount with its Dr or Cr in the same cell', () => {
  it('is paid out when it says Dr, with no column to say so', async () => {
    const rows = await read([
      'Date,Narration,Amount,Balance',
      '02/11/2026,NEFT A,"50,000.00 Cr","51,000.00 Cr"',
      '03/11/2026,RTGS B,"70,000.00 Dr","19,000.00 Dr"',
    ]);
    expect(rows.map((r) => [r.direction, r.amount, r.balance])).toEqual([['in', 50000, 51000], ['out', 70000, -19000]]);
  });

  it('a Dr / Cr column still decides when there is one', async () => {
    const rows = await read([
      'Date,Narration,Amount,Dr/Cr',
      '02/11/2026,NEFT A,"50,000.00",Cr',
      '03/11/2026,RTGS B,"70,000.00",Dr',
    ]);
    expect(rows.map((r) => r.direction)).toEqual(['in', 'out']);
  });
});

describe('the date of a line', () => {
  it('is read from the ways banks write it', () => {
    for (const [text, day] of [
      ['20/11/2026', '2026-11-20'], ['20-11-26', '2026-11-20'], ['2026-11-20', '2026-11-20'], ['20-Nov-2026', '2026-11-20'], ['20 Nov 26', '2026-11-20'],
      ['20.11.2026', '2026-11-20'], ['20 November 2026', '2026-11-20'], ['5 Sept 2026', '2026-09-05'], ['20/11/2026 14:35:10', '2026-11-20'],
    ]) {
      const d = bank.parseDate(text);
      expect(d && ymd(d)).toBe(day);
    }
  });

  it('is not a date when the day does not exist, or the month comes first', () => {
    for (const text of ['31/02/2026', '31/04/2026', '11/20/2026', '00/11/2026', '2026-13-01', '2026-02-30', '32 Jan 2026', '']) expect(bank.parseDate(text)).toBeNull();
  });

  it('a line whose date cannot be read stops the file, with the row and what it says', async () => {
    const usStyle = read([
      'Date,Narration,Debit,Credit,Balance',
      '11/02/2026,NEFT A,,500.00,1500.00',
      '11/20/2026,NEFT B,200.00,,1300.00',
    ]);
    await expect(usStyle).rejects.toMatchObject({ code: 'STATEMENT_DATE', status: 400 });
    await expect(usStyle).rejects.toThrow(/row 3.*11\/20\/2026.*day\/month\/year/i);
    await expect(read(['Date,Narration,Debit,Credit', '31/02/2026,NEFT A,,500.00'])).rejects.toThrow(/31\/02\/2026/);
  });

  it('rows that are not transactions are passed over as before', async () => {
    const rows = await read([
      'Statement for 01/11/2026 to 30/11/2026',
      'Date,Narration,Debit,Credit,Balance',
      ',Opening balance,,,1000.00',
      '20/11/2026,NEFT A,,500.00,1500.00',
      '31/02/2026,(no amount on this row),,,',
      'Total,,200.00,500.00,',
      'Page 1 of 1,,,,',
    ]);
    expect(rows.map((r) => r.narration)).toEqual(['NEFT A']);
  });
});

describe('a one-day statement written newest first', () => {
  it('takes its opening and closing balances from the right ends', async () => {
    const rows = await read([
      'Date,Narration,Debit,Credit,Balance',
      '20/11/2026,THIRD,,300.00,1600.00',
      '20/11/2026,SECOND,200.00,,1300.00',
      '20/11/2026,FIRST,,500.00,1500.00',
    ]);
    expect(bank.openingOf(rows)).toBe(1000);
    expect(bank.closingOf(rows)).toBe(1600);
  });

  it('and oldest first as before', async () => {
    const rows = await read([
      'Date,Narration,Debit,Credit,Balance',
      '20/11/2026,FIRST,,500.00,1500.00',
      '20/11/2026,SECOND,200.00,,1300.00',
      '20/11/2026,THIRD,,300.00,1600.00',
    ]);
    expect(bank.openingOf(rows)).toBe(1000);
    expect(bank.closingOf(rows)).toBe(1600);
  });
});
