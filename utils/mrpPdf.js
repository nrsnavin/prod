'use strict';
//
// Renders a Material Requirement Program (MRP) sheet PDF for one job
// order. Pure over a plain data object so it's unit-testable without a
// DB. Returns a Buffer.
//
// Layout:
//   • Title + job/order/customer meta
//   • Production mode banner (in-house / outsource) + vendor line
//   • Elastic lines (what's being produced)
//   • Material requirement table (material, required kg, in stock,
//     shortfall) with a shortfall highlight
//   • Signature block: Prepared by / Approved by / Received by

const PDFDocument = require("pdfkit");

const DARK   = "#1f2937";
const MUTED  = "#6b7280";
const ACCENT = "#2563eb";
const RED    = "#dc2626";
const LINE   = "#d1d5db";

function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-IN") : String(n);
}
function _kg(n) {
  const v = Number(n) || 0;
  return `${v.toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
}

function _bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// data = {
//   jobOrderNo, orderNo, customerName, dateLabel, status,
//   productionMode: "in_house"|"outsource", outsourceVendor,
//   elastics: [{ name, quantity }],
//   materials: [{ name, category, requiredWeight, inStock, shortfall }],
// }
async function buildMrpPdf(data) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // ── Header ──────────────────────────────────────────────────────
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(20)
    .text("Material Requirement Program", left, doc.y);
  doc.moveDown(0.2);
  doc.fillColor(MUTED).font("Helvetica").fontSize(10)
    .text("MRP sheet — raw material planning for one job order");
  doc.moveDown(0.5);
  doc.strokeColor(ACCENT).lineWidth(2)
    .moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.7);

  // ── Meta grid ───────────────────────────────────────────────────
  const metaTop = doc.y;
  const col = width / 2;
  const metaPairs = [
    ["Job Order #", data.jobOrderNo != null ? String(data.jobOrderNo) : "—"],
    ["Order #",     data.orderNo != null ? String(data.orderNo) : "—"],
    ["Customer",    data.customerName || "—"],
    ["Date",        data.dateLabel || "—"],
    ["Status",      data.status || "—"],
  ];
  doc.fontSize(10);
  metaPairs.forEach((pair, i) => {
    const x = left + (i % 2) * col;
    const y = metaTop + Math.floor(i / 2) * 18;
    doc.fillColor(MUTED).font("Helvetica").text(`${pair[0]}: `, x, y, { continued: true });
    doc.fillColor(DARK).font("Helvetica-Bold").text(pair[1]);
  });
  doc.y = metaTop + Math.ceil(metaPairs.length / 2) * 18 + 8;

  // ── Production mode banner ──────────────────────────────────────
  const outsource = data.productionMode === "outsource";
  const bannerLabel = outsource ? "OUTSOURCED PRODUCTION" : "IN-HOUSE PRODUCTION";
  const bannerColor = outsource ? "#b45309" : ACCENT;
  doc.rect(left, doc.y, width, 22).fill(bannerColor);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11)
    .text(bannerLabel, left + 8, doc.y - 16);
  doc.moveDown(1.2);
  if (outsource) {
    doc.fillColor(DARK).font("Helvetica").fontSize(10)
      .text(`Vendor / Subcontractor: ${data.outsourceVendor || "________________________"}`);
    doc.fillColor(MUTED).fontSize(9)
      .text("Materials below are to be issued to the vendor against this sheet.");
    doc.moveDown(0.6);
  }

  // ── Elastics being produced ─────────────────────────────────────
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(12).text("Elastics to produce");
  doc.moveDown(0.3);
  doc.fillColor(DARK).font("Helvetica").fontSize(10);
  if ((data.elastics || []).length) {
    for (const e of data.elastics) {
      doc.text(`• ${e.name || "Unknown"} — ${_num(e.quantity)} m`);
    }
  } else {
    doc.fillColor(MUTED).text("No elastic lines on this job.");
  }
  doc.moveDown(0.7);

  // ── Material requirement table ──────────────────────────────────
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(12).text("Raw material requirement");
  doc.moveDown(0.4);

  const cols = [
    { key: "name",           label: "Material",   w: 0.40, align: "left"  },
    { key: "requiredWeight", label: "Required",   w: 0.20, align: "right" },
    { key: "inStock",        label: "In stock",   w: 0.20, align: "right" },
    { key: "shortfall",      label: "Shortfall",  w: 0.20, align: "right" },
  ];
  const rowH = 18;
  let y = doc.y;

  // Header row
  doc.rect(left, y, width, rowH).fill("#f3f4f6");
  let x = left;
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(9.5);
  for (const c of cols) {
    const cw = c.w * width;
    doc.text(c.label, x + 4, y + 5, { width: cw - 8, align: c.align });
    x += cw;
  }
  y += rowH;

  const materials = data.materials || [];
  doc.font("Helvetica").fontSize(9.5);
  if (materials.length === 0) {
    doc.fillColor(MUTED).text("No BOM materials resolved for the elastics on this job.", left + 4, y + 5);
    y += rowH;
  } else {
    for (const m of materials) {
      // page break guard
      if (y + rowH > doc.page.height - 160) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      const short = Number(m.shortfall) > 0;
      if (short) {
        doc.rect(left, y, width, rowH).fill("#fef2f2");
      }
      x = left;
      const cells = {
        name:           m.name + (m.category ? `  (${m.category})` : ""),
        requiredWeight: _kg(m.requiredWeight),
        inStock:        _kg(m.inStock),
        shortfall:      short ? _kg(m.shortfall) : "—",
      };
      for (const c of cols) {
        const cw = c.w * width;
        doc.fillColor(c.key === "shortfall" && short ? RED : DARK)
          .font(c.key === "shortfall" && short ? "Helvetica-Bold" : "Helvetica")
          .text(String(cells[c.key]), x + 4, y + 5, { width: cw - 8, align: c.align });
        x += cw;
      }
      doc.strokeColor(LINE).lineWidth(0.5)
        .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
      y += rowH;
    }
  }
  doc.y = y + 10;

  const anyShort = materials.some((m) => Number(m.shortfall) > 0);
  if (anyShort) {
    doc.fillColor(RED).font("Helvetica-Bold").fontSize(9)
      .text("⚠ Shortfall rows are highlighted — raise a purchase order before starting production.");
    doc.moveDown(0.5);
  }

  // ── Signature block ─────────────────────────────────────────────
  // Pin near the bottom of the current page.
  const sigY = Math.max(doc.y + 20, doc.page.height - 130);
  const boxW = (width - 40) / 3;
  const labels = ["Prepared by", "Approved by", "Received by"];
  labels.forEach((label, i) => {
    const bx = left + i * (boxW + 20);
    // signature line
    doc.strokeColor(DARK).lineWidth(0.8)
      .moveTo(bx, sigY + 34).lineTo(bx + boxW, sigY + 34).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(label, bx, sigY + 40, { width: boxW, align: "center" });
    doc.fillColor("#9ca3af").fontSize(7)
      .text("Name / Signature / Date", bx, sigY + 52, { width: boxW, align: "center" });
  });

  return _bufferFromDoc(doc);
}

module.exports = { buildMrpPdf };
