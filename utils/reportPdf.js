'use strict';
//
// PDF rendering for the daily WhatsApp reports. Takes the same data
// objects that the text formatters (utils/digest.js and
// utils/eveningReport.js) consume so the PDF and the WhatsApp body
// always show identical numbers.
//
// PDFKit is already a dependency. Buffers are returned to the
// caller; the caller decides where to persist them.

const PDFDocument = require("pdfkit");

const TITLE_FONT  = "Helvetica-Bold";
const BODY_FONT   = "Helvetica";
const COLOR_DARK  = "#1f2937";
const COLOR_MUTED = "#6b7280";
const COLOR_ACCENT = "#2563eb";

function _bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function _drawHeader(doc, title, subtitle) {
  doc.fillColor(COLOR_DARK).font(TITLE_FONT).fontSize(22).text(title);
  doc.moveDown(0.2);
  doc.fillColor(COLOR_MUTED).font(BODY_FONT).fontSize(11).text(subtitle);
  doc.moveDown(0.6);
  doc.strokeColor(COLOR_ACCENT).lineWidth(2)
    .moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.8);
}

function _drawSection(doc, title) {
  doc.fillColor(COLOR_ACCENT).font(TITLE_FONT).fontSize(13).text(title);
  doc.moveDown(0.3);
  doc.fillColor(COLOR_DARK).font(BODY_FONT).fontSize(11);
}

function _line(doc, text) {
  doc.fillColor(COLOR_DARK).font(BODY_FONT).fontSize(11).text(text);
}

function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-IN") : String(n);
}

// ── Morning digest ────────────────────────────────────────────────
async function buildMorningDigestPdf(d) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  _drawHeader(doc, "Morning digest", `Yesterday — ${d.dateLabel}`);

  _drawSection(doc, "Production (yesterday)");
  if (d.production.shifts > 0) {
    _line(doc, `${_num(d.production.meters)} m across ${d.production.shifts} shift(s)`);
  } else {
    _line(doc, "No closed shifts.");
  }
  doc.moveDown(0.6);

  _drawSection(doc, "Wastage (yesterday)");
  if (d.wastage.entries > 0) {
    _line(doc, `${_num(d.wastage.meters)} m over ${d.wastage.entries} entr${d.wastage.entries === 1 ? "y" : "ies"}` +
      (d.wastage.penalty > 0 ? ` · penalty ₹${_num(d.wastage.penalty)}` : ""));
    if (d.wastage.topReason) _line(doc, `Top reason: ${d.wastage.topReason}`);
  } else {
    _line(doc, "None recorded.");
  }
  doc.moveDown(0.6);

  _drawSection(doc, "Projected stockouts");
  if ((d.stockouts || []).length > 0) {
    for (const s of d.stockouts.slice(0, 10)) {
      _line(doc, `• ${s.name}: ~${s.daysToStockout}d left (stock ${_num(s.stock)})`);
    }
    if (d.stockouts.length > 10) _line(doc, `… and ${d.stockouts.length - 10} more`);
  } else {
    _line(doc, "None within horizon.");
  }
  doc.moveDown(0.6);

  if ((d.predictedLate || []).length > 0) {
    _drawSection(doc, "Predicted late (ML)");
    for (const o of d.predictedLate.slice(0, 10)) {
      _line(doc, `• Order #${o.orderNo}${o.customerName ? ` · ${o.customerName}` : ""}: ${o.lateWorkingDays}d late`);
    }
    doc.moveDown(0.6);
  }

  if ((d.posteriorDrift || []).length > 0) {
    _drawSection(doc, "Posterior drift (7d vs prior 7d)");
    for (const x of d.posteriorDrift.slice(0, 10)) {
      _line(doc, `• ${x.machineLabel || "?"} · ${x.elasticName || "?"}: ↓${Math.round(x.dropPct)}%`);
    }
    doc.moveDown(0.6);
  }

  if (d.attendance) {
    _drawSection(doc, "Attendance (yesterday)");
    const a = d.attendance;
    if (a.totalEffective > 0) {
      _line(doc, `${a.totalEffective} effective present` +
        (a.percentOfBaseline != null ? ` (${Math.round(a.percentOfBaseline)}% of 7d baseline)` : ""));
      if (a.absent > 0) _line(doc, `${a.absent} absent · ${a.onLeave} on leave`);
    } else {
      _line(doc, "No attendance marked.");
    }
    doc.moveDown(0.6);
  }

  if (d.leave && d.leave.pending > 0) {
    _drawSection(doc, "Leave requests pending");
    _line(doc, `${d.leave.pending} request(s) awaiting decision`);
    doc.moveDown(0.6);
  }

  if (d.complaints && d.complaints.openCount > 0) {
    _drawSection(doc, "Open employee complaints");
    _line(doc, `${d.complaints.openCount} open` +
      (d.complaints.newYesterday > 0 ? ` · ${d.complaints.newYesterday} new yesterday` : ""));
    doc.moveDown(0.6);
  }

  _drawSection(doc, "Maintenance due");
  if ((d.maintenance || []).length > 0) {
    for (const m of d.maintenance.slice(0, 10)) {
      _line(doc, `• ${m.ID}: ${m.overdue ? "OVERDUE" : `in ${m.daysUntil}d`}`);
    }
  } else {
    _line(doc, "Nothing due.");
  }

  return _bufferFromDoc(doc);
}

// ── Evening report ────────────────────────────────────────────────
async function buildEveningReportPdf(d) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  _drawHeader(doc, "Evening report", `Today — ${d.dateLabel}`);

  _drawSection(doc, "Production (today)");
  if (d.production.shifts > 0) {
    _line(doc, `${_num(d.production.meters)} m across ${d.production.shifts} shift(s)`);
  } else {
    _line(doc, "No shifts closed yet today.");
  }
  doc.moveDown(0.6);

  _drawSection(doc, "Wastage (today)");
  if (d.wastage.entries > 0) {
    _line(doc, `${_num(d.wastage.meters)} m over ${d.wastage.entries} entr${d.wastage.entries === 1 ? "y" : "ies"}` +
      (d.wastage.penalty > 0 ? ` · penalty ₹${_num(d.wastage.penalty)}` : ""));
    if (d.wastage.topReason) _line(doc, `Top reason: ${d.wastage.topReason}`);
  } else {
    _line(doc, "None recorded.");
  }
  doc.moveDown(0.6);

  _drawSection(doc, "Deliveries (today)");
  if (d.deliveries.count > 0) {
    _line(doc, `${d.deliveries.count} DC(s) · ${_num(d.deliveries.totalQuantity)} m · ₹${_num(d.deliveries.totalAmount)}`);
    doc.moveDown(0.3);
    for (const dc of d.deliveries.items.slice(0, 20)) {
      _line(doc, `• ${dc.dcNumber}${dc.orderNo ? ` · Order #${dc.orderNo}` : ""} · ${dc.customerName}: ${_num(dc.totalQuantity)} m`);
    }
    if (d.deliveries.items.length > 20) {
      _line(doc, `… and ${d.deliveries.items.length - 20} more`);
    }
  } else {
    _line(doc, "No dispatches today.");
  }

  return _bufferFromDoc(doc);
}

module.exports = {
  buildMorningDigestPdf,
  buildEveningReportPdf,
};
