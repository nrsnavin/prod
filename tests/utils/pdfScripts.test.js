'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NAME IN TAMIL OR HINDI, ON PAPER (utils/pdfScripts.js)
//
//  The built-in PDF font has neither script: a payslip for முருகன்
//  printed an empty name. A line is cut into runs by script and each run
//  drawn in a font that has it. Held here: where the cuts fall, that a
//  Latin line is drawn as it always was, and that a line too wide for
//  its room is cut between characters, never inside one.
// ══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const { drawLine, runsOf, hasOtherScript, useScripts } = require('../../utils/pdfScripts');

const render = (draw) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A5', margin: 20 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  doc.on('error', reject);
  draw(doc);
  doc.end();
});

describe('cutting a line into runs', () => {
  it('keeps each script whole, with the space between its own words', () => {
    expect(runsOf('முருகன் K (Sr) राजेश कुमार 12')).toEqual([
      { script: 'Tamil', text: 'முருகன்' },
      { script: null, text: ' K (Sr) ' },
      { script: 'Devanagari', text: 'राजेश कुमार' },
      { script: null, text: ' 12' },
    ]);
    expect(runsOf('செல்வி ராஜா')).toEqual([{ script: 'Tamil', text: 'செல்வி ராஜா' }]);
  });

  it('leaves Latin as one run, and nothing as no runs', () => {
    expect(runsOf('Ravi Kumar (weaving)')).toEqual([{ script: null, text: 'Ravi Kumar (weaving)' }]);
    expect(runsOf('')).toEqual([]);
    expect(runsOf(null)).toEqual([]);
  });

  it('keeps a joiner with the word it is in, and drops one that joins nothing', () => {
    const joined = 'க்‍ஷ';
    expect(runsOf(joined)).toEqual([{ script: 'Tamil', text: joined }]);
    expect(runsOf('A‍B')).toEqual([{ script: null, text: 'AB' }]);
  });

  it('knows which text needs another font', () => {
    expect(hasOtherScript('Ravi Kumar ₹ — é')).toBe(false);
    expect(hasOtherScript('ரவி')).toBe(true);
    expect(hasOtherScript('रवि')).toBe(true);
    expect(hasOtherScript(undefined)).toBe(false);
  });
});

describe('drawing a line', () => {
  it('embeds a font for each script on the line, in the weight asked for', async () => {
    const pdf = await render((doc) => {
      drawLine(doc, 'முருகன் K', 20, 20, { bold: true, size: 10 });
      drawLine(doc, 'राजेश', 20, 40, { size: 10 });
    });
    expect(pdf).toMatch(/NotoSansTamil-Bold/);
    expect(pdf).toMatch(/NotoSansDevanagari-Regular/);
    expect(pdf).not.toMatch(/NotoSansTamil-Regular/);
  });

  it('CONTROL: a Latin line needs none of them', async () => {
    const pdf = await render((doc) => { drawLine(doc, 'Ravi Kumar', 20, 20, { bold: true, size: 10, width: 200 }); });
    expect(pdf).not.toMatch(/NotoSans/);
    expect(pdf).toMatch(/Helvetica-Bold/);
  });

  it('says how wide it drew, and never draws wider than its room', async () => {
    const widths = {};
    await render((doc) => {
      widths.short = drawLine(doc, 'முருகன்', 20, 20, { size: 10, width: 300 });
      widths.cut = drawLine(doc, 'வேலுச்சாமி பொன்னுசாமி கார்த்திகேயன் சுப்பிரமணியம்', 20, 40, { size: 10, width: 120 });
      widths.free = drawLine(doc, 'வேலுச்சாமி பொன்னுசாமி கார்த்திகேயன் சுப்பிரமணியம்', 20, 60, { size: 10 });
      widths.latin = drawLine(doc, 'A very long Latin name that will not fit in this room at all', 20, 80, { size: 10, width: 120 });
    });
    expect(widths.short).toBeGreaterThan(20);
    expect(widths.short).toBeLessThan(300);
    expect(widths.cut).toBeLessThanOrEqual(120);
    expect(widths.cut).toBeGreaterThan(80);   // cut to fit, not to nothing
    expect(widths.free).toBeGreaterThan(200);
    expect(widths.latin).toBeLessThanOrEqual(120);
  });

  it('leaves the document on the Latin font it was given, at the size it drew', async () => {
    await render((doc) => {
      drawLine(doc, 'முருகன்', 20, 20, { font: 'Helvetica', bold: true, size: 9.5 });
      expect(doc._font.name).toBe('Helvetica-Bold');
      expect(doc._fontSize).toBe(9.5);
    });
  });

  it('registers the fonts once for a document, and says which loaded', async () => {
    await render((doc) => {
      const first = useScripts(doc);
      expect([...first].sort()).toEqual(['Devanagari', 'Tamil']);
      expect(useScripts(doc)).toBe(first);
    });
  });
});

// The sheets that print people's names beside the payslip and the bonus
// certificate (which have their own tests): the printed shift sheet, and
// the tables every report is exported as.
describe('the other sheets that print a name', () => {
  const sd = (n) => `64a000000000000000000${String(n).padStart(3, '0')}`;

  it('the shift sheet prints an operator in Tamil or Hindi', async () => {
    const { buildShiftSheetPdf } = require('../../utils/shiftSheetPdf');
    const sheet = (operators) => buildShiftSheetPdf({
      dateLabel: '10 Nov 2026', shift: 'DAY', planNo: 'SP-1',
      rows: operators.map((operator, i) => ({ sdId: sd(i + 1), machine: `L-0${i + 1}`, operator, job: `J-10${i}` })),
    });
    const mixed = (await sheet(['முருகன் K', 'राजेश कुमार', 'Ravi Kumar'])).toString('latin1');
    expect(mixed).toMatch(/NotoSansTamil-Regular/);
    expect(mixed).toMatch(/NotoSansDevanagari-Regular/);
    // CONTROL: a sheet of Latin names is the file it always was.
    expect((await sheet(['Ravi Kumar', 'Priya S'])).toString('latin1')).not.toMatch(/NotoSans/);
  });

  it('a report table prints one too, and leaves its numbers alone', async () => {
    const { toPdf } = require('../../services/reportEngine/export');
    const table = (names) => toPdf({
      columns: [{ key: 'name', label: 'Employee', type: 'text' }, { key: 'pay', label: 'Net pay', type: 'money' }],
      rows: names.map((name, i) => ({ name, pay: 1000 + i })),
      rowCount: names.length, totals: {},
    }, { title: 'Payroll register', company: 'Balu Elastics' });
    const withTamil = Buffer.from(await table(['செல்வி ராஜா', 'Ravi Kumar'])).toString('latin1');
    expect(withTamil).toMatch(/NotoSansTamil-Regular/);
    expect(Buffer.from(await table(['Ravi Kumar'])).toString('latin1')).not.toMatch(/NotoSans/);
  });
});
