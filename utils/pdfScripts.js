'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NAME IN TAMIL OR HINDI, ON PAPER
//
//  pdfkit's built-in Helvetica holds Western European letters and
//  nothing else, so a payslip for முருகன் printed an empty name (and,
//  before that, a row of the wrong letters). utils/pdfLatin.js made such
//  text safe to print by dropping it. This prints it.
//
//  Two fonts are bundled (utils/fonts, SIL Open Font License): Noto Sans
//  Tamil and Noto Sans Devanagari, each the subset for its own script —
//  they hold no Latin letters or digits. So a line is cut into runs by
//  script, each run drawn in the font that has it, all on one baseline
//  (the three fonts sit at different heights in their boxes). The
//  joining and reordering these scripts need — செ is written ச then ெ
//  and drawn the other way round — is done by the PDF library's font
//  engine; this only has to hand it each run whole.
//
//    drawLine(doc, 'முருகன் K', x, y, { bold: true, size: 9.5, width, color })
//
//  A line with nothing but Latin in it is drawn exactly as it always
//  was, through latin1(). If a font file cannot be read, its script is
//  dropped as before rather than the page failing.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { latin1 } = require('./pdfLatin');

const FONT_DIR = path.join(__dirname, 'fonts');

const SCRIPTS = [
  { name: 'Tamil',      from: 0x0B80, to: 0x0BFF, regular: 'NotoSansTamil-Regular.woff',      bold: 'NotoSansTamil-Bold.woff' },
  { name: 'Devanagari', from: 0x0900, to: 0x097F, regular: 'NotoSansDevanagari-Regular.woff', bold: 'NotoSansDevanagari-Bold.woff' },
];
/** Zero-width joiner and non-joiner: part of the word they sit in. */
const JOINERS = new Set([0x200C, 0x200D]);
const SPACE = 0x20;

const scriptOf = (cp) => SCRIPTS.find((s) => cp >= s.from && cp <= s.to) || null;

/** Whether any of it is in a script the built-in font cannot print and these can. */
function hasOtherScript(text) {
  for (const ch of String(text ?? '')) if (scriptOf(ch.codePointAt(0))) return true;
  return false;
}

/**
 * A line cut into runs by script: [{ script: 'Tamil' | 'Devanagari' | null, text }].
 * A space between two words of one script stays in their run; a joiner
 * stays with the word it is in; everything else is a Latin run.
 */
function runsOf(text) {
  const runs = [];
  const chars = [...String(text ?? '')];
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0);
    const last = runs[runs.length - 1];
    let script = scriptOf(cp)?.name ?? null;
    if (JOINERS.has(cp)) {
      if (!last?.script) return;      // a joiner with nothing to join
      script = last.script;
    } else if (cp === SPACE && last?.script) {
      // Kept in the run only when the same script carries on after it.
      const next = chars.slice(i + 1).find((c) => c.codePointAt(0) !== SPACE);
      if (next && scriptOf(next.codePointAt(0))?.name === last.script) script = last.script;
    }
    if (last && last.script === script) last.text += ch;
    else runs.push({ script, text: ch });
  });
  return runs;
}

// Which documents have had the fonts registered, and which loaded.
const registered = new WeakMap();

/** Register the script fonts on a document (once); the scripts that loaded. */
function useScripts(doc) {
  if (registered.has(doc)) return registered.get(doc);
  const loaded = new Set();
  for (const s of SCRIPTS) {
    try {
      const regular = path.join(FONT_DIR, s.regular);
      const bold = path.join(FONT_DIR, s.bold);
      fs.accessSync(regular, fs.constants.R_OK);
      fs.accessSync(bold, fs.constants.R_OK);
      doc.registerFont(s.name, regular);
      doc.registerFont(`${s.name}-Bold`, bold);
      loaded.add(s.name);
    } catch (err) {
      console.warn(`[pdf] ${s.name} font not available — text in it is left out: ${err.message}`);
    }
  }
  registered.set(doc, loaded);
  return loaded;
}

/** Latin text the built-in font can print, with its spacing kept (it joins other runs). */
const latinRun = (s) => String(s)
  .replace(/₹\s?/g, 'Rs. ')
  .replace(/[–—]/g, '-')
  .replace(/[^\x20-\xFF]/g, '')
  .replace(/\s{2,}/g, ' ');

/** Characters as a reader counts them, so a cut never lands inside one. */
function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((g) => g.segment);
  }
  return [...text];
}

/**
 * One line of text that may hold Tamil or Hindi beside Latin, drawn left
 * to right from (x, y) on one baseline, cut with "..." when it is wider
 * than `width`.
 *
 * @param {PDFDocument} doc
 * @param {*} text
 * @param {number} x
 * @param {number} y              top of the line, as doc.text takes it
 * @param {object} [opts]
 * @param {string} [opts.font='Helvetica']  the Latin font; its bold is `${font}-Bold`
 * @param {boolean} [opts.bold=false]
 * @param {string} [opts.latinFont]  the Latin font by its exact name, for a sheet
 *                                that registers its own (the reports print in DejaVu)
 * @param {(s: string) => string} [opts.clean]  what is done to the Latin runs; by
 *                                default what the built-in font cannot print is dropped
 * @param {number} [opts.size]    defaults to the document's current size
 * @param {number} [opts.width]   the room there is; unlimited when not given
 * @param {string} [opts.color]
 * @returns {number} the width drawn
 */
function drawLine(doc, text, x, y, opts = {}) {
  const { font = 'Helvetica', bold = false, width, color, clean = latinRun } = opts;
  const size = opts.size ?? doc._fontSize;
  const latinFont = opts.latinFont || (bold ? `${font}-Bold` : font);
  const raw = String(text ?? '');
  if (color) doc.fillColor(color);

  // Nothing but Latin: as it has always been drawn.
  if (!hasOtherScript(raw)) {
    const plain = opts.clean ? opts.clean(raw) : latin1(raw);
    doc.font(latinFont).fontSize(size);
    const options = { lineBreak: false };
    if (width != null) { options.width = width; options.ellipsis = true; }
    doc.text(plain, x, y, options);
    return Math.min(doc.widthOfString(plain), width ?? Infinity);
  }

  const loaded = useScripts(doc);
  const fontOf = (run) => (run.script ? `${run.script}${bold ? '-Bold' : ''}` : latinFont);
  const measure = (run) => doc.font(fontOf(run)).fontSize(size).widthOfString(run.text);

  let runs = runsOf(raw)
    .filter((r) => !r.script || loaded.has(r.script))
    .map((r) => (r.script ? r : { script: null, text: clean(r.text) }))
    .filter((r) => r.text.length > 0);
  // Trimmed at the two ends only: the spaces between runs are the words' own.
  if (runs.length) {
    runs[0] = { ...runs[0], text: runs[0].text.replace(/^\s+/, '') };
    const end = runs.length - 1;
    runs[end] = { ...runs[end], text: runs[end].text.replace(/\s+$/, '') };
    runs = runs.filter((r) => r.text.length > 0);
  }

  // Too wide for the room: characters come off the end, never half of one.
  if (width != null) {
    const dots = { script: null, text: '...' };
    const total = () => runs.reduce((sum, r) => sum + measure(r), 0);
    if (total() > width) {
      const room = width - measure(dots);
      while (runs.length && total() > room) {
        const last = runs[runs.length - 1];
        const kept = graphemes(last.text).slice(0, -1).join('');
        if (kept) runs[runs.length - 1] = { ...last, text: kept };
        else runs.pop();
      }
      runs.push(dots);
    }
  }

  // One baseline for every run: the Latin font's, where the line would
  // have sat anyway. Each font fills its box differently, so drawn from
  // the same top the scripts hang lower than the Latin beside them.
  doc.font(latinFont).fontSize(size);
  const baseline = y + (doc._font.ascender / 1000) * size;
  let cx = x;
  for (const run of runs) {
    const w = measure(run);
    doc.text(run.text, cx, baseline, { lineBreak: false, baseline: 'alphabetic' });
    cx += w;
  }
  doc.font(latinFont).fontSize(size);
  return cx - x;
}

module.exports = { drawLine, runsOf, hasOtherScript, useScripts, SCRIPTS };
