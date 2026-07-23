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
  // Generous, balanced margins keep text clear of the paper edge and the
  // printer's unprintable border, and leave room for the signature block.
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 54, bottom: 60, left: 54, right: 54 },
    // Needed so the footer pass can switchToPage() across every page.
    bufferPages: true,
  });
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  // ── Header ──────────────────────────────────────────────────────
  // Company name from Document Settings (data.branding), with a default.
  const brand = data.branding || {};
  const accent = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(brand.accent || "") ? brand.accent : ACCENT;
  doc.fillColor(accent).font("Helvetica-Bold").fontSize(11)
    .text(brand.company || "Balu Elastics", left, doc.y);
  doc.moveDown(0.15);
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(20)
    .text("Material Requirement Program", left, doc.y);
  doc.moveDown(0.2);
  doc.fillColor(MUTED).font("Helvetica").fontSize(10)
    .text("MRP sheet — raw material planning for one job order");
  doc.moveDown(0.5);
  doc.strokeColor(accent).lineWidth(2)
    .moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.8);

  // ── Meta grid ───────────────────────────────────────────────────
  const metaTop = doc.y;
  const col = width / 2;
  const metaRowH = 19;
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
    const y = metaTop + Math.floor(i / 2) * metaRowH;
    doc.fillColor(MUTED).font("Helvetica").text(`${pair[0]}: `, x, y, { continued: true });
    doc.fillColor(DARK).font("Helvetica-Bold").text(pair[1]);
  });
  doc.y = metaTop + Math.ceil(metaPairs.length / 2) * metaRowH + 10;

  // ── Production mode banner ──────────────────────────────────────
  const outsource = data.productionMode === "outsource";
  const bannerLabel = outsource ? "OUTSOURCED PRODUCTION" : "IN-HOUSE PRODUCTION";
  const bannerColor = outsource ? "#b45309" : accent;
  const bannerH = 24;
  const bannerY = doc.y;
  doc.rect(left, bannerY, width, bannerH).fill(bannerColor);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11)
    .text(bannerLabel, left + 10, bannerY + 7, { width: width - 20 });
  doc.y = bannerY + bannerH + 10;
  if (outsource) {
    doc.fillColor(DARK).font("Helvetica").fontSize(10)
      .text(`Vendor / Subcontractor: ${data.outsourceVendor || "________________________"}`, left, doc.y);
    doc.fillColor(MUTED).fontSize(9)
      .text("Materials below are to be issued to the vendor against this sheet.");
    doc.moveDown(0.6);
  }

  // ── Elastics being produced ─────────────────────────────────────
  doc.fillColor(accent).font("Helvetica-Bold").fontSize(12).text("Elastics to produce", left, doc.y);
  doc.moveDown(0.35);
  doc.fillColor(DARK).font("Helvetica").fontSize(10);
  if ((data.elastics || []).length) {
    for (const e of data.elastics) {
      doc.text(`•  ${e.name || "Unknown"} — ${_num(e.quantity)} m`, { indent: 2 });
      doc.moveDown(0.15);
    }
  } else {
    doc.fillColor(MUTED).text("No elastic lines on this job.");
  }
  doc.moveDown(0.8);

  // ── Material requirement table ──────────────────────────────────
  doc.fillColor(accent).font("Helvetica-Bold").fontSize(12).text("Raw material requirement", left, doc.y);
  doc.moveDown(0.45);

  const cols = [
    { key: "name",           label: "Material",   w: 0.40, align: "left"  },
    { key: "requiredWeight", label: "Required",   w: 0.20, align: "right" },
    { key: "inStock",        label: "In stock",   w: 0.20, align: "right" },
    { key: "shortfall",      label: "Shortfall",  w: 0.20, align: "right" },
  ];
  const rowH = 20;
  const pad = 6;
  let y = doc.y;

  // Column x offsets, precomputed so gridlines and cells align.
  const colX = [];
  let acc = left;
  for (const c of cols) { colX.push(acc); acc += c.w * width; }

  // Draws the shaded header row at vertical position `hy`; returns the
  // next y. Re-used on every page so the table always has a header.
  const drawHeader = (hy) => {
    doc.rect(left, hy, width, rowH).fill("#eef2ff");
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10);
    cols.forEach((c, i) => {
      const cw = c.w * width;
      doc.text(c.label, colX[i] + pad, hy + 6, { width: cw - pad * 2, align: c.align });
    });
    return hy + rowH;
  };
  // Outer box + column separators for the current page's table segment.
  // Drawn per page so a table that paginates keeps a clean grid on each.
  const closeSegment = (segTop, segBottom) => {
    doc.strokeColor(LINE).lineWidth(0.7).rect(left, segTop, width, segBottom - segTop).stroke();
    doc.lineWidth(0.5).strokeColor(LINE);
    for (let i = 1; i < cols.length; i++) {
      doc.moveTo(colX[i], segTop).lineTo(colX[i], segBottom).stroke();
    }
  };
  let segTop = y;
  y = drawHeader(y);

  const materials = data.materials || [];
  if (materials.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
      .text("No BOM materials resolved for the elastics on this job.", left + pad, y + 6);
    y += rowH;
  } else {
    materials.forEach((m, idx) => {
      // Keep the signature block's worth of space; break to a fresh page
      // (with a repeated header) when a row would collide with it.
      if (y + rowH > bottomLimit - 150) {
        closeSegment(segTop, y);
        doc.addPage();
        segTop = doc.page.margins.top;
        y = drawHeader(segTop);
      }
      const short = Number(m.shortfall) > 0;
      // Zebra striping for scan-ability; shortfall rows get a red wash.
      if (short) doc.rect(left, y, width, rowH).fill("#fef2f2");
      else if (idx % 2 === 1) doc.rect(left, y, width, rowH).fill("#f9fafb");

      const cells = {
        name:           m.name + (m.category ? `  (${m.category})` : ""),
        requiredWeight: _kg(m.requiredWeight),
        inStock:        _kg(m.inStock),
        shortfall:      short ? _kg(m.shortfall) : "—",
      };
      cols.forEach((c, i) => {
        const cw = c.w * width;
        doc.fillColor(c.key === "shortfall" && short ? RED : DARK)
          .font(c.key === "shortfall" && short ? "Helvetica-Bold" : "Helvetica")
          .fontSize(10)
          .text(String(cells[c.key]), colX[i] + pad, y + 6, { width: cw - pad * 2, align: c.align });
      });
      doc.strokeColor(LINE).lineWidth(0.5)
        .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
      y += rowH;
    });
  }

  // Close the final page's table segment.
  closeSegment(segTop, y);
  doc.y = y + 12;

  const anyShort = materials.some((m) => Number(m.shortfall) > 0);
  if (anyShort) {
    doc.fillColor(RED).font("Helvetica-Bold").fontSize(9)
      .text("Shortfall rows are highlighted — raise a purchase order before starting production.", left, doc.y);
    doc.moveDown(0.5);
  }

  // ── Signature block ─────────────────────────────────────────────
  // Pin near the bottom of the current page, above the footer.
  const sigY = Math.max(doc.y + 24, bottomLimit - 78);
  const boxGap = 24;
  const boxW = (width - boxGap * 2) / 3;
  const labels = ["Prepared by", "Approved by", "Received by"];
  labels.forEach((label, i) => {
    const bx = left + i * (boxW + boxGap);
    doc.strokeColor(DARK).lineWidth(0.8)
      .moveTo(bx, sigY + 34).lineTo(bx + boxW, sigY + 34).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(label, bx, sigY + 40, { width: boxW, align: "center" });
    doc.fillColor("#9ca3af").fontSize(7)
      .text("Name / Signature / Date", bx, sigY + 52, { width: boxW, align: "center" });
  });

  // ── Footer on every page: generated timestamp + page numbers ────
  const range = doc.bufferedPageRange();
  const genLabel = `Generated ${new Date().toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  })}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin. Zero the page's bottom
    // margin for the write so pdfkit doesn't treat it as an overflow and
    // spawn a blank continuation page; restore it afterwards.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - savedBottom + 22;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8)
      .text(genLabel, left, fy, { width: width / 2, align: "left", lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, fy, {
      width: width / 2, align: "right", lineBreak: false,
    });
    doc.page.margins.bottom = savedBottom;
  }

  return _bufferFromDoc(doc);
}

module.exports = { buildMrpPdf };
