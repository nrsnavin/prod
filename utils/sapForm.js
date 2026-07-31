'use strict';
//
// Shared visual language for the printed forms — delivery challan,
// purchase order, MRP sheet, warping and covering programmes.
//
// The look is a dense monochrome business form: hairline-ruled boxes,
// small-caps labels above their values, a grey header band on tables, and
// a signature strip. Deliberately not branded — these are working
// documents that go to a driver, a gate clerk or a machine operator, and
// most of them are printed on a mono laser. Colour is used only where it
// carries meaning that bold alone cannot (a stock shortfall), and never as
// the only signal.

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#999999';
const HEADER_BG = '#E4E4E4';
/** Very light — readable when printed in mono, visible in colour. */
const ALERT_BG = '#FBECEC';
const ALERT_INK = '#A02020';

/** Small-caps field label sitting above its value inside a ruled box. */
function boxLabel(doc, text, x, y, w) {
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED)
    .text(String(text).toUpperCase(), x, y, { width: w, lineBreak: false });
}

/** The value under a boxLabel. */
function boxValue(doc, text, x, y, w, opts = {}) {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(opts.fontSize || 9)
    .fillColor(opts.color || INK)
    .text(text === undefined || text === null || text === '' ? '—' : String(text), x, y, {
      width: w, align: opts.align || 'left', lineBreak: opts.lineBreak !== false,
    });
}

/** A label/value pair inside a ruled box, returning the y below it. */
function field(doc, label, value, x, y, w, opts = {}) {
  boxLabel(doc, label, x, y, w);
  boxValue(doc, value, x, y + 9, w, opts);
  return y + 22;
}

/** Hairline rectangle. */
function box(doc, x, y, w, h, opts = {}) {
  doc.rect(x, y, w, h).lineWidth(opts.lineWidth || 0.6)
    .strokeColor(opts.color || RULE).stroke();
}

/** The document title in its own ruled box, top-right. */
function titleBox(doc, title, x, y, w, h = 26) {
  doc.rect(x, y, w, h).lineWidth(0.8).strokeColor(INK).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
    .text(String(title).toUpperCase(), x + 4, y + 8, {
      width: w - 8, align: 'center', lineBreak: false,
    });
}

/**
 * Three-way signature strip. `labels` defaults to the shop-floor set;
 * a purchase order or challan passes its own.
 */
function signatureStrip(doc, x, y, w, labels, h = 52) {
  const cells = labels && labels.length ? labels : ['Prepared by', 'Checked by', 'Received by'];
  box(doc, x, y, w, h);
  const cw = w / cells.length;
  for (let i = 1; i < cells.length; i++) {
    doc.moveTo(x + i * cw, y).lineTo(x + i * cw, y + h)
      .lineWidth(0.6).strokeColor(RULE).stroke();
  }
  cells.forEach((label, i) => {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(label, x + i * cw + 6, y + h - 14, { width: cw - 12, lineBreak: false });
  });
  return y + h;
}

module.exports = {
  INK, MUTED, RULE, HEADER_BG, ALERT_BG, ALERT_INK,
  boxLabel, boxValue, field, box, titleBox, signatureStrip,
};
