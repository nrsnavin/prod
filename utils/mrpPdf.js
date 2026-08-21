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
const {
  INK, MUTED, RULE, HEADER_BG, ALERT_BG, ALERT_INK,
  boxLabel, boxValue, box, titleBox, signatureStrip,
} = require("./sapForm");

// Aliases so the drawing code below reads the same as the other forms.
const DARK = INK;
const LINE = RULE;

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
//   materials: [{ name, category, requiredWeight, inStock, onOrder,
//                 shortfall }],
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

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(15)
    .text(brand.company || "Balu Elastics", left, 40, { width: 300, lineBreak: false });
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5)
    .text("Material requirement planning for one job order", left, 58, { width: 300, lineBreak: false });

  titleBox(doc, "MRP SHEET", right - 165, 38, 165);

  // Identity grid — ruled boxes with small-caps labels, not inline pairs.
  const metaY = 70;
  const metaH = 46;
  box(doc, right - 165, metaY, 165, metaH);
  boxLabel(doc, "Job order", right - 160, metaY + 5, 78);
  boxValue(doc, data.jobOrderNo != null ? `J-${data.jobOrderNo}` : "—", right - 160, metaY + 15, 78, { bold: true });
  boxLabel(doc, "Date", right - 78, metaY + 5, 72);
  boxValue(doc, data.dateLabel || "—", right - 78, metaY + 15, 72, { fontSize: 8 });
  boxLabel(doc, "Order / Status", right - 160, metaY + 29, 155);
  boxValue(doc, `${data.orderNo != null ? `#${data.orderNo}` : "—"}  ·  ${data.status || "—"}`,
    right - 160, metaY + 37, 155, { fontSize: 7.5 });

  doc.strokeColor(INK).lineWidth(1.2)
    .moveTo(left, 124).lineTo(right, 124).stroke();

  // Customer pane. The customer's own PO and the promised supply date sit
  // beside the name: an MRP is read to decide what to buy and by when,
  // and both answers were previously somewhere else entirely.
  box(doc, left, 134, width, 40);
  boxLabel(doc, "Customer", left + 6, 140, 260);
  boxValue(doc, data.customerName || "—", left + 6, 150, 260, { bold: true, fontSize: 10 });
  boxLabel(doc, "Customer PO", left + 290, 140, 110);
  boxValue(doc, data.customerPo || "—", left + 290, 150, 110, { fontSize: 9 });
  boxLabel(doc, "Supply date", left + 410, 140, 110);
  boxValue(doc, data.supplyDateLabel || "—", left + 410, 150, 110, { fontSize: 9 });
  doc.y = 184;

  // ── Production mode ─────────────────────────────────────────────
  // A ruled row rather than a colour banner: these sheets print in mono on
  // the floor, so the distinction has to survive without colour.
  const outsource = data.productionMode === "outsource";
  const modeY = doc.y;
  const modeH = outsource ? 42 : 26;
  box(doc, left, modeY, width, modeH);
  boxLabel(doc, "Production mode", left + 6, modeY + 5, 150);
  boxValue(doc, outsource ? "OUTSOURCED" : "IN-HOUSE", left + 6, modeY + 14, 150, { bold: true });
  if (outsource) {
    boxLabel(doc, "Vendor / subcontractor", left + 200, modeY + 5, 200);
    boxValue(doc, data.outsourceVendor || "________________________", left + 200, modeY + 14, width - 206);
    doc.font("Helvetica").fontSize(7).fillColor(MUTED)
      .text("Materials below are to be issued to the vendor against this sheet.",
        left + 6, modeY + 30, { width: width - 12, lineBreak: false });
  }
  doc.y = modeY + modeH + 12;

  // ── Elastics being produced ─────────────────────────────────────
  // A ruled mini-table: a bullet list reads as prose, and this is a form.
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(7)
    .text("ELASTICS TO PRODUCE", left, doc.y);
  let ey = doc.y + 11;
  const elasticRows = data.elastics || [];
  const eQtyX = right - 110;

  doc.rect(left, ey, width, 16).fill(HEADER_BG);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(8)
    .text("Elastic", left + 6, ey + 4, { width: eQtyX - left - 12, lineBreak: false })
    .text("Quantity (m)", eQtyX, ey + 4, { width: 104, align: "right", lineBreak: false });
  box(doc, left, ey, width, 16);
  ey += 16;

  if (elasticRows.length) {
    for (const e of elasticRows) {
      doc.fillColor(INK).font("Helvetica").fontSize(8.5)
        .text(e.name || "Unknown", left + 6, ey + 4, { width: eQtyX - left - 12, lineBreak: false })
        .text(_num(e.quantity), eQtyX, ey + 4, { width: 104, align: "right", lineBreak: false });
      box(doc, left, ey, width, 16);
      ey += 16;
    }
  } else {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
      .text("No elastic lines on this job.", left + 6, ey + 4, { width: width - 12, lineBreak: false });
    box(doc, left, ey, width, 16);
    ey += 16;
  }
  doc.y = ey + 14;

  // ── Material requirement table ──────────────────────────────────
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(7)
    .text("RAW MATERIAL REQUIREMENT", left, doc.y);
  doc.moveDown(0.9);

  const cols = [
    { key: "name",           label: "Material",   w: 0.26, align: "left"  },
    // The supplier is already resolved when the requirement is computed.
    // Without it on the sheet, deciding who to buy a shortfall from means
    // leaving the sheet and looking each material up again.
    { key: "supplierName",   label: "Supplier",   w: 0.20, align: "left"  },
    { key: "requiredWeight", label: "Required",   w: 0.14, align: "right" },
    { key: "inStock",        label: "In stock",   w: 0.14, align: "right" },
    // Bought but not yet delivered. Its own column, never netted off the
    // shortfall: reading a shortfall as covered because yarn is on order
    // is how a machine ends up waiting for stock the sheet called
    // sufficient — and how the same PO gets raised twice.
    { key: "onOrder",        label: "On order",   w: 0.13, align: "right" },
    { key: "shortfall",      label: "Shortfall",  w: 0.13, align: "right" },
  ];
  const materials = data.materials || [];

  // ── The dye lots, under the material name ───────────────────────
  // A column of its own would have meant taking width from the five
  // that already earn theirs, and the lot belongs beside the material
  // anyway: an operator reads down the name column and needs the bag
  // number at the same glance, not four columns to the right.
  //
  // Each lot is marked with WHICH decision put it there, because
  // three different sentences arrive in one list:
  //
  //   set aside   the order earmarked this bag at approval — a claim
  //               on the yarn, made before any beam existed;
  //   programmed  the warping plan chose it for a beam section;
  //   (bare)      it is merely open on the rack.
  //
  // Printing them alike would have somebody warping off the wrong bag.
  // Said in words rather than symbols — these print in mono, and a
  // glyph that does not render is worse than no marker at all.
  const LOT_MARK = { order: " (set aside)", programme: " (programmed)" };
  const lotLine = (m) => {
    const lots = m.lotOptions || [];
    if (!lots.length) return "";
    const shown = lots
      .slice(0, 3)
      .map((l) => (l.lotNo ? `${l.lotNo}${LOT_MARK[l.source] || ""}` : ""))
      .filter(Boolean);
    if (!shown.length) return "";
    const more = lots.length > shown.length ? ` +${lots.length - shown.length}` : "";
    return `Lot ${shown.join(" · ")}${more}`;
  };

  const anyLots = materials.some((m) => lotLine(m));
  // Taller rows only when there is a second line to put in them, so a
  // sheet with no lot tracking prints exactly as it did before.
  const rowH = anyLots ? 28 : 20;
  const pad = 6;
  let y = doc.y;

  // Column x offsets, precomputed so gridlines and cells align.
  const colX = [];
  let acc = left;
  for (const c of cols) { colX.push(acc); acc += c.w * width; }

  // Draws the shaded header row at vertical position `hy`; returns the
  // next y. Re-used on every page so the table always has a header.
  const drawHeader = (hy) => {
    doc.rect(left, hy, width, rowH).fill(HEADER_BG);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
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
      // No zebra — a ruled grid does the scan-ability job without the
      // banding. A shortfall row gets a wash AND bold text, because these
      // sheets are printed in mono and colour alone would say nothing.
      if (short) doc.rect(left, y, width, rowH).fill(ALERT_BG);

      const cells = {
        name:           m.name + (m.category ? `  (${m.category})` : ""),
        // Named plainly when absent: a material with no supplier cannot
        // be ordered at all, and that is the sheet's problem to raise.
        supplierName:   m.supplierName || "— not set —",
        requiredWeight: _kg(m.requiredWeight),
        inStock:        _kg(m.inStock),
        onOrder:        Number(m.onOrder) > 0 ? _kg(m.onOrder) : "—",
        shortfall:      short ? _kg(m.shortfall) : "—",
      };
      cols.forEach((c, i) => {
        const cw = c.w * width;
        doc.fillColor(c.key === "shortfall" && short ? ALERT_INK : INK)
          .font(short ? "Helvetica-Bold" : "Helvetica")
          .fontSize(9)
          .text(String(cells[c.key]), colX[i] + pad, y + 6, { width: cw - pad * 2, align: c.align });
      });

      const lots = lotLine(m);
      if (lots) {
        doc.fillColor(MUTED).font("Helvetica").fontSize(7)
          .text(lots, colX[0] + pad, y + 17, { width: cols[0].w * width - pad * 2, lineBreak: false });
      }
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
    doc.fillColor(ALERT_INK).font("Helvetica-Bold").fontSize(8)
      .text("Rows in bold are short — raise a purchase order before starting production.", left, doc.y);
    doc.moveDown(0.5);
  }

  // ── Signature strip ─────────────────────────────────────────────
  // Boxed, matching the challan and purchase order, and pinned above the
  // footer so it lands in the same place on every sheet.
  const sigY = Math.max(doc.y + 20, bottomLimit - 70);
  signatureStrip(doc, left, sigY, width, ["Prepared by", "Approved by", "Received by"]);

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
