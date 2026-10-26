'use strict';
// ══════════════════════════════════════════════════════════════════
//  WARPING AND COVERING PROGRAMMES (PDF)
//
//  The sheets that go to the warping and covering machines. They were
//  printed from the browser, which put a blank first page in front,
//  left a tape heading alone at the foot of a page with its beams on
//  the next, and sized every beam table's columns to its own text so no
//  two lined up. Drawn here instead, the way the MRP sheet is: A4, the
//  same hairline-ruled form as the challan and the MRP (utils/
//  sapForm.js), narrow margins so a beam plan fits on fewer pages.
//
//  Layout rules every table here follows:
//    • fixed column widths, the same for every beam, so they line up;
//    • the header repeats when a table runs onto the next page;
//    • a heading is never left at the foot of a page — it moves with
//      the first rows under it;
//    • a beam that fits on a page is never split across two.
//
//  Pure over plain data objects (built in api/warping.js and
//  api/covering.js), so each is tested without a database.
// ══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const {
  INK, MUTED, RULE, HEADER_BG,
  boxLabel, boxValue, box, titleBox, signatureStrip,
} = require('./sapForm');

/** ~10 mm: clear of a laser's unprintable border, little wasted paper. */
const MARGIN = 28;
const FOOTER_SPACE = 16;
const ROW_H = 17;
const HEAD_H = 17;
const SIGN_H = 46;

const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-IN') : '—');
const dash = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));

/**
 * `text` cut to fit `width` at the current font, with an ellipsis.
 * pdfkit wraps rather than clipping when a word is wider than its box,
 * which put a long elastic name over the row beneath.
 */
function fit(doc, text, width) {
  const t = String(text ?? '');
  if (doc.widthOfString(t) <= width) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${t.slice(0, mid)}…`) <= width) lo = mid; else hi = mid - 1;
  }
  return `${t.slice(0, lo)}…`;
}

function bufferOf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** The page frame: doc, its usable area, and a cursor that knows when to turn the page. */
function frame() {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const f = {
    doc,
    left,
    right,
    width: right - left,
    top: MARGIN,
    bottom: doc.page.height - MARGIN - FOOTER_SPACE,
    y: MARGIN,
    /** Room for `h` more points on this page, or a new page. */
    need(h) {
      if (f.y + h > f.bottom) {
        doc.addPage();
        f.y = f.top;
        return true;
      }
      return false;
    },
  };
  return f;
}

/** Header block: company, sheet name, the identity grid; returns nothing, moves the cursor. */
function header(f, { company, subtitle, title, fields }) {
  const { doc, left, right } = f;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14)
    .text(company || 'Balu Elastics', left, f.y + 2, { width: 300, lineBreak: false });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text(subtitle, left, f.y + 20, { width: 300, lineBreak: false });

  const boxW = 190;
  const bx = right - boxW;
  titleBox(doc, title, bx, f.y, boxW, 24);

  // Two fields a row, as many rows as there are fields.
  const gy = f.y + 30;
  const rows = Math.ceil(fields.length / 2);
  const gh = rows * 22 + 6;
  box(doc, bx, gy, boxW, gh);
  fields.forEach((fld, i) => {
    const cx = bx + 6 + (i % 2) * (boxW / 2);
    const cy = gy + 5 + Math.floor(i / 2) * 22;
    boxLabel(doc, fld.label, cx, cy, boxW / 2 - 12);
    doc.font(fld.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    boxValue(doc, fit(doc, dash(fld.value), boxW / 2 - 12), cx, cy + 8, boxW / 2 - 12, { bold: !!fld.bold, fontSize: 8.5, lineBreak: false });
  });

  const below = gy + gh + 6;
  doc.strokeColor(INK).lineWidth(1.1).moveTo(left, below).lineTo(right, below).stroke();
  f.y = below + 8;
}

/** A labelled ruled pane, full width. */
function pane(f, items) {
  const { doc, left, width } = f;
  const h = 30;
  f.need(h);
  box(doc, left, f.y, width, h);
  const each = width / items.length;
  items.forEach((it, i) => {
    boxLabel(doc, it.label, left + 6 + i * each, f.y + 5, each - 12);
    doc.font(it.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    boxValue(doc, fit(doc, dash(it.value), each - 12), left + 6 + i * each, f.y + 14, each - 12, { bold: !!it.bold, fontSize: 9.5, lineBreak: false });
  });
  f.y += h + 10;
}

/** A small-caps section heading; moves with what follows it (`keep` points). */
function section(f, text, keep = HEAD_H + ROW_H) {
  f.need(12 + keep);
  f.doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5)
    .text(String(text).toUpperCase(), f.left, f.y, { width: f.width, lineBreak: false });
  f.y += 12;
}

/**
 * A ruled table with fixed columns.
 *   cols: [{ label, w (fraction), align }]
 *   rows: arrays of cell strings
 *   opts.title     text spanning the header's first columns (a beam's name)
 *   opts.titleSpan how many columns the title covers
 *   opts.foot      a bold last row
 *   opts.keepWhole move the whole table to the next page if it fits there
 */
function table(f, cols, rows, opts = {}) {
  const { doc, left, width } = f;
  const xs = [];
  let acc = left;
  for (const c of cols) { xs.push(acc); acc += c.w * width; }
  const cw = (i) => cols[i].w * width;
  const pad = 5;

  const total = HEAD_H + rows.length * ROW_H + (opts.foot ? ROW_H : 0);
  const pageRoom = f.bottom - f.top;
  if (opts.keepWhole && total <= pageRoom) f.need(total);
  else f.need(HEAD_H + ROW_H); // never a header alone

  const drawHead = () => {
    doc.rect(left, f.y, width, HEAD_H).fill(HEADER_BG);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
    if (opts.title) {
      const span = opts.titleSpan || 1;
      let w = 0;
      for (let i = 0; i < span; i++) w += cw(i);
      doc.text(fit(doc, opts.title, w - pad * 2), xs[0] + pad, f.y + 5, { width: w - pad * 2, lineBreak: false });
      for (let i = span; i < cols.length; i++) {
        doc.text(cols[i].label, xs[i] + pad, f.y + 5, { width: cw(i) - pad * 2, align: cols[i].align || 'left', lineBreak: false });
      }
    } else {
      cols.forEach((c, i) => doc.text(c.label, xs[i] + pad, f.y + 5, { width: cw(i) - pad * 2, align: c.align || 'left', lineBreak: false }));
    }
    box(doc, left, f.y, width, HEAD_H);
    f.y += HEAD_H;
  };

  let segTop = f.y;
  const closeSeg = () => {
    doc.lineWidth(0.5).strokeColor(RULE);
    const start = opts.title ? (opts.titleSpan || 1) : 1;
    // The title spans its columns in the header only; the body has every line.
    for (let i = 1; i < cols.length; i++) {
      const fromY = i < start ? segTop + HEAD_H : segTop;
      doc.moveTo(xs[i], fromY).lineTo(xs[i], f.y).stroke();
    }
    box(doc, left, segTop, width, f.y - segTop);
  };

  drawHead();
  const drawRow = (cells, bold) => {
    if (f.y + ROW_H > f.bottom) {
      closeSeg();
      doc.addPage();
      f.y = f.top;
      segTop = f.y;
      drawHead();
    }
    doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    cells.forEach((cell, i) => {
      if (cell == null || cell === '') return;
      doc.text(fit(doc, cell, cw(i) - pad * 2), xs[i] + pad, f.y + 5, { width: cw(i) - pad * 2, align: cols[i].align || 'left', lineBreak: false });
    });
    doc.strokeColor(RULE).lineWidth(0.5).moveTo(left, f.y + ROW_H).lineTo(left + width, f.y + ROW_H).stroke();
    f.y += ROW_H;
  };
  rows.forEach((r) => drawRow(r, false));
  if (opts.foot) drawRow(opts.foot, true);
  closeSeg();
  f.y += opts.gap ?? 8;
}

/** Remarks, wrapped, in a ruled pane. */
function remarks(f, text) {
  if (!text) return;
  const { doc, left, width } = f;
  doc.font('Helvetica').fontSize(8.5);
  const h = Math.max(28, doc.heightOfString(String(text), { width: width - 12 }) + 20);
  f.need(h);
  box(doc, left, f.y, width, h);
  boxLabel(doc, 'Remarks', left + 6, f.y + 5, width - 12);
  doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(String(text), left + 6, f.y + 14, { width: width - 12 });
  f.y += h + 10;
}

/** Signatures at the end, and the footer on every page. */
function finish(f, labels) {
  f.need(SIGN_H + 14);
  signatureStrip(f.doc, f.left, f.y + 8, f.width, labels, SIGN_H);

  const { doc, left, width } = f;
  const range = doc.bufferedPageRange();
  const gen = `Generated ${new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - MARGIN - 6;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7)
      .text(f.footerLeft || gen, left, fy, { width: width * 0.7, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, left + width * 0.7, fy, { width: width * 0.3, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  return bufferOf(doc);
}

// ── Warping ───────────────────────────────────────────────────────

/** A beam's total ends: as stored, or the sum of its sections when it was never stored. */
function beamEnds(beam) {
  const stored = Number(beam.totalEnds);
  if (stored > 0) return stored;
  return (beam.sections || []).reduce((s, x) => s + (Number(x.ends) || 0), 0);
}

/**
 * Beams grouped by tape in the order they are built, as the screen
 * groups them (programmeShared.groupBeamsByTape): consecutive beams of
 * one tape together, a tape that comes back later as a new group. A
 * plan with no tapes is one group with no heading.
 */
function byTape(beams) {
  if (!beams.some((b) => b.tapeNo != null)) return beams.length ? [{ tapeNo: null, beams }] : [];
  const groups = [];
  for (const b of beams) {
    const tapeNo = b.tapeNo ?? null;
    const last = groups[groups.length - 1];
    if (last && last.tapeNo === tapeNo) last.beams.push(b);
    else groups.push({ tapeNo, beams: [b] });
  }
  return groups;
}

/**
 * data = {
 *   jobOrderNo, customerName, orderNo, dateLabel, status, remarks, branding,
 *   elastics: [{ name, quantity }],
 *   plan: null | { beams: [{ beamNo, tapeNo, elasticName, pairedBeamNo, totalEnds,
 *                           sections: [{ yarn, lot, ends, maxMeters }] }] }
 * }
 */
async function buildWarpingProgrammePdf(data) {
  const f = frame();
  const beams = data.plan?.beams || [];
  const tapes = byTape(beams);
  const tapeCount = new Set(beams.map((b) => b.tapeNo).filter((t) => t != null)).size;

  header(f, {
    company: data.branding?.company,
    subtitle: 'Beam build sheet for one job order',
    title: 'Warping Programme',
    fields: [
      { label: 'Job order', value: data.jobOrderNo != null ? `J-${data.jobOrderNo}` : '—', bold: true },
      { label: 'Opened', value: dash(data.dateLabel) },
      { label: 'Status', value: dash(data.status) },
      { label: 'Beams', value: data.plan ? beams.length : '—' },
      ...(tapeCount > 1 ? [{ label: 'Tapes', value: tapeCount }] : []),
    ],
  });

  pane(f, [
    { label: 'Customer', value: dash(data.customerName), bold: true },
    { label: 'Order', value: data.orderNo != null ? `#${data.orderNo}` : '—' },
  ]);

  section(f, 'Elastics');
  const elastics = data.elastics || [];
  table(f,
    [{ label: 'Elastic', w: 0.78 }, { label: 'Quantity (m)', w: 0.22, align: 'right' }],
    elastics.length ? elastics.map((e) => [dash(e.name), num(e.quantity)]) : [['No elastics on this programme.', '']],
    { gap: 12 });

  const planLabel = !data.plan
    ? 'Beam plan — not created yet'
    : `Beam plan — ${beams.length} beam${beams.length === 1 ? '' : 's'}${tapeCount > 1 ? ` over ${tapeCount} tapes` : ''}`;

  if (!data.plan || beams.length === 0) {
    section(f, planLabel, 30);
    pane(f, [{ label: 'Plan', value: 'Create the beam plan on the warping page before warping starts.' }]);
  } else {
    section(f, planLabel, 0);
    // The same columns for every beam, so they line up down the page.
    const cols = [
      { label: '#', w: 0.06 },
      { label: 'Warp yarn', w: 0.40 },
      { label: 'Dye lot', w: 0.28 },
      { label: 'Ends', w: 0.11, align: 'right' },
      { label: 'Length (m)', w: 0.15, align: 'right' },
    ];
    tapes.forEach((tape) => {
      tape.beams.forEach((beam, bi) => {
        const sections = beam.sections || [];
        const rowsH = HEAD_H + Math.max(1, sections.length) * ROW_H + ROW_H;
        // A tape heading moves with its first beam.
        if (tape.tapeNo != null && bi === 0) {
          // The first beam is kept whole when it fits on a page, so the
          // heading needs room for all of it, not just its first rows.
          f.need(22 + (rowsH <= f.bottom - f.top - 22 ? rowsH : HEAD_H + ROW_H));
          const ends = tape.beams.reduce((s, b) => s + beamEnds(b), 0);
          f.doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
            .text(`TAPE ${tape.tapeNo}`, f.left, f.y + 2, { width: f.width / 2, lineBreak: false });
          f.doc.font('Helvetica').fontSize(8.5)
            .text(`${tape.beams.length} beam${tape.beams.length === 1 ? '' : 's'} · ${num(ends)} ends`,
              f.left + f.width / 2, f.y + 3, { width: f.width / 2, align: 'right', lineBreak: false });
          f.doc.strokeColor(INK).lineWidth(0.9).moveTo(f.left, f.y + 15).lineTo(f.right, f.y + 15).stroke();
          f.y += 20;
        }
        const ends = beamEnds(beam);
        const title = [
          `Beam ${beam.beamNo ?? bi + 1}`,
          beam.elasticName || null,
          beam.pairedBeamNo ? `run with beam ${beam.pairedBeamNo}` : null,
        ].filter(Boolean).join(' · ');
        table(f, cols,
          sections.length
            ? sections.map((s, si) => [si + 1, dash(s.yarn), dash(s.lot), num(s.ends), s.maxMeters != null ? num(s.maxMeters) : '—'])
            : [['', 'No sections', '', '', '']],
          {
            title, titleSpan: 2, keepWhole: true, gap: 6,
            foot: ['', 'Total', '', num(ends), ''],
          });
      });
    });
  }

  remarks(f, data.remarks);
  return finish(f, ['Warper', 'Supervisor', 'Checked by']);
}

// ── Covering ──────────────────────────────────────────────────────

const BEAM_ROWS = 20;
const kg = (n) => (Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(2));

/**
 * data = {
 *   jobOrderNo, customerName, orderNo, dateLabel, status, remarks, branding,
 *   sheetRef,   // "CV-" + the last six of the covering id
 *   lines: [{ name, quantity, warpSpandex, spandexCovering, spandexEnds, totalWeight }],
 *   beamEntries: [{ beamNo, weight, note }],
 *   producedWeight
 * }
 */
async function buildCoveringProgrammePdf(data) {
  const f = frame();
  const lines = data.lines || [];

  header(f, {
    company: data.branding?.company,
    subtitle: 'Covering build sheet for one job order',
    title: 'Covering Programme',
    fields: [
      { label: 'Job order', value: data.jobOrderNo != null ? `J-${data.jobOrderNo}` : '—', bold: true },
      { label: 'Opened', value: dash(data.dateLabel) },
      { label: 'Status', value: dash(data.status) },
      // Printed so a photo of the filled sheet can be matched back to
      // this covering (utils/coveringBeamOcr.js reads it).
      { label: 'Sheet ref', value: dash(data.sheetRef), bold: true },
    ],
  });

  pane(f, [
    { label: 'Customer', value: dash(data.customerName), bold: true },
    { label: 'Order', value: data.orderNo != null ? `#${data.orderNo}` : '—' },
  ]);

  section(f, `Elastics — ${lines.length} item${lines.length === 1 ? '' : 's'}`);
  let expected = 0;
  const rows = lines.map((l, i) => {
    const wt = Number(l.totalWeight) || 0;
    const exp = wt > 0 ? (Number(l.quantity) * wt) / 1000 : null;
    if (exp) expected += exp;
    return [i + 1, dash(l.name), num(l.quantity), dash(l.warpSpandex), dash(l.spandexCovering),
      l.spandexEnds != null ? num(l.spandexEnds) : '—', wt > 0 ? wt.toFixed(2) : '—', exp != null ? exp.toFixed(2) : '—'];
  });
  table(f,
    [
      { label: '#', w: 0.05 },
      { label: 'Elastic', w: 0.29 },
      { label: 'Qty (m)', w: 0.09, align: 'right' },
      { label: 'Warp spandex', w: 0.145 },
      { label: 'Sp. covering', w: 0.145 },
      { label: 'Sp. ends', w: 0.08, align: 'right' },
      { label: 'Wt (g/m)', w: 0.09, align: 'right' },
      { label: 'Exp. (kg)', w: 0.11, align: 'right' },
    ],
    rows.length ? rows : [['', 'No elastics planned.', '', '', '', '', '', '']],
    { foot: expected > 0 ? ['', 'Expected covering weight', '', '', '', '', '', `${expected.toFixed(2)}`] : null, gap: 12 });

  // Beam weights: 20 rows at least, two side by side, written in at the machine.
  const entries = [...(data.beamEntries || [])].sort((a, b) => a.beamNo - b.beamNo);
  const count = Math.max(BEAM_ROWS, entries.length);
  const half = Math.ceil(count / 2);
  const cell = (i) => {
    const e = entries[i];
    return [i + 1, e ? e.beamNo : '', e ? kg(e.weight) : '', e?.note || ''];
  };
  section(f, entries.length
    ? `Beam weights — ${entries.length} recorded, the rest blank for entry`
    : 'Beam weights — to be entered at the machine', HEAD_H + ROW_H * Math.min(half, 6));

  // Two half-width tables drawn row by row together, so they turn the page together.
  const { doc } = f;
  const gap = 10;
  const halfW = (f.width - gap) / 2;
  const cols = [
    { label: 'S.No', w: 0.16, align: 'center' },
    { label: 'Beam #', w: 0.20, align: 'center' },
    { label: 'Weight (kg)', w: 0.28, align: 'right' },
    { label: 'Remarks', w: 0.36 },
  ];
  const drawHalf = (x0, cells, headerRow) => {
    let x = x0;
    cols.forEach((c, i) => {
      const w = c.w * halfW;
      if (headerRow) doc.rect(x, f.y, w, HEAD_H).fill(HEADER_BG);
      doc.fillColor(INK).font(headerRow ? 'Helvetica-Bold' : 'Helvetica').fontSize(headerRow ? 7.5 : 8.5)
        .text(fit(doc, headerRow ? c.label : (cells[i] ?? ''), w - 8), x + 4, f.y + 5, { width: w - 8, align: c.align || 'left', lineBreak: false });
      box(doc, x, f.y, w, headerRow ? HEAD_H : ROW_H);
      x += w;
    });
  };
  const heads = () => { drawHalf(f.left, null, true); drawHalf(f.left + halfW + gap, null, true); f.y += HEAD_H; };
  f.need(HEAD_H + ROW_H);
  heads();
  for (let r = 0; r < half; r++) {
    if (f.y + ROW_H > f.bottom) { doc.addPage(); f.y = f.top; heads(); }
    drawHalf(f.left, cell(r), false);
    drawHalf(f.left + halfW + gap, r + half < count ? cell(r + half) : ['', '', '', ''], false);
    f.y += ROW_H;
  }
  const recorded = Number(data.producedWeight) || entries.reduce((s, e) => s + (Number(e.weight) || 0), 0);
  f.need(22);
  const tw = 190;
  box(doc, f.right - tw, f.y + 4, tw, 18);
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7)
    .text('TOTAL RECORDED WEIGHT', f.right - tw + 6, f.y + 10, { width: 110, lineBreak: false });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5)
    .text(recorded > 0 ? `${kg(recorded)} kg` : '________ kg', f.right - 76, f.y + 9, { width: 70, align: 'right', lineBreak: false });
  f.y += 30;

  remarks(f, data.remarks);
  return finish(f, ['Covering operator', 'Supervisor', 'Checked by']);
}

module.exports = { buildWarpingProgrammePdf, buildCoveringProgrammePdf, beamEnds, byTape, MARGIN };
