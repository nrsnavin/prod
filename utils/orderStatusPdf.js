'use strict';
//
// ORDER STATUS REPORT — the printed sheet.
//
// Pure over the plain object from services/orderStatusReport.js, so it is
// unit-testable without a database. Returns a Buffer.
//
// Same monochrome ruled form as the challan, purchase order and MRP
// sheet (utils/sapForm.js): hairline boxes, small-caps labels above
// their values, a grey band on table headers. These go in a file or get
// faxed to a customer, and most of them print on a mono laser — so
// anything that matters is said in bold and words, never in colour alone.
//
// Sections, in the order the question is usually asked:
//   1. Order lines     — ordered / produced / packed / pending per elastic
//   2. Job status      — every job, its stage, machine, warping, covering
//   3. Production      — what the floor recorded, against what jobs claim
//   4. Pending         — what is still owed, and how it sits against the
//                        supply date

const PDFDocument = require('pdfkit');
const {
  INK, MUTED, RULE, HEADER_BG, ALERT_BG, ALERT_INK,
  boxLabel, boxValue, box, titleBox, signatureStrip,
} = require('./sapForm');

const _num = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-IN') : String(n ?? '—');
};

function _bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function buildOrderStatusPdf(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, bottom: 60, left: 42, right: 42 },
    bufferPages: true,
  });
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const brand = data.branding || {};

  // ── Letterhead ──────────────────────────────────────────────────
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
    .text(brand.company || 'Balu Elastics', left, 40, { width: 300, lineBreak: false });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
    .text('Order status — jobs, production and pending quantities', left, 58,
      { width: 300, lineBreak: false });

  titleBox(doc, 'ORDER STATUS', right - 175, 38, 175);

  // Identity grid.
  const metaY = 70;
  const metaH = 46;
  box(doc, right - 175, metaY, 175, metaH);
  boxLabel(doc, 'Order no', right - 170, metaY + 5, 82);
  boxValue(doc, data.orderNo != null ? `#${data.orderNo}` : '—', right - 170, metaY + 15, 82, { bold: true });
  boxLabel(doc, 'Status', right - 84, metaY + 5, 78);
  boxValue(doc, data.status || '—', right - 84, metaY + 15, 78, { bold: true, fontSize: 8 });
  boxLabel(doc, 'Order date / Supply date', right - 170, metaY + 29, 165);
  boxValue(doc, `${data.orderDate || '—'}   ·   ${data.supplyDate || '—'}`,
    right - 170, metaY + 37, 165, { fontSize: 7.5 });

  doc.strokeColor(INK).lineWidth(1.2).moveTo(left, 124).lineTo(right, 124).stroke();

  // ── Customer pane ───────────────────────────────────────────────
  box(doc, left, 134, width, 44);
  boxLabel(doc, 'Customer', left + 6, 140, 300);
  boxValue(doc, data.customerName || '—', left + 6, 150, width - 200, { bold: true, fontSize: 10 });
  const sub = [data.customerGstin && `GSTIN ${data.customerGstin}`, data.customerAddress]
    .filter(Boolean).join('   ·   ');
  if (sub) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(sub, left + 6, 164, { width: width - 200, lineBreak: false });
  }
  boxLabel(doc, 'Customer PO', right - 180, 140, 174);
  boxValue(doc, data.customerPo || '—', right - 180, 150, 174, { bold: true });
  doc.y = 190;

  // ── Delivery position ───────────────────────────────────────────
  // Bold and worded, with a wash behind it. On a mono print the wash
  // greys out and the words still carry the whole message.
  const days = data.daysToSupply;
  let deliveryLine;
  if (days == null) deliveryLine = 'No supply date set on this order.';
  else if (data.overdue) deliveryLine = `OVERDUE by ${Math.abs(days)} day(s) — supply date was ${data.supplyDate}.`;
  else if (data.dueSoon) deliveryLine = `Due in ${days} day(s) — supply date ${data.supplyDate}.`;
  else if (data.status === 'Completed') deliveryLine = `Completed. Supply date was ${data.supplyDate}.`;
  else deliveryLine = `${days} day(s) to the supply date of ${data.supplyDate}.`;

  const flagged = data.overdue || data.dueSoon;
  const dY = doc.y;
  if (flagged) doc.rect(left, dY, width, 24).fill(ALERT_BG);
  box(doc, left, dY, width, 24);
  doc.fillColor(data.overdue ? ALERT_INK : INK)
    .font(flagged ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .text(deliveryLine, left + 6, dY + 8, { width: width - 12, lineBreak: false });
  doc.y = dY + 34;

  // ── Shared table machinery ──────────────────────────────────────
  // One implementation for all four sections, so their grids line up and
  // every one of them paginates the same way.
  const pad = 5;
  const rowH = 18;

  function drawTable({ title, cols, rows, totalRow, emptyText }) {
    const colX = [];
    let acc = left;
    for (const c of cols) { colX.push(acc); acc += c.w * width; }

    const header = (hy) => {
      doc.rect(left, hy, width, rowH).fill(HEADER_BG);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
      cols.forEach((c, i) => {
        doc.text(c.label, colX[i] + pad, hy + 5,
          { width: c.w * width - pad * 2, align: c.align || 'left', lineBreak: false });
      });
      return hy + rowH;
    };
    const close = (top, bottom) => {
      doc.strokeColor(RULE).lineWidth(0.7).rect(left, top, width, bottom - top).stroke();
      doc.lineWidth(0.5).strokeColor(RULE);
      for (let i = 1; i < cols.length; i++) {
        doc.moveTo(colX[i], top).lineTo(colX[i], bottom).stroke();
      }
    };

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(7)
      .text(title, left, doc.y, { lineBreak: false });
    let y = doc.y + 11;
    let segTop = y;
    y = header(y);

    const writeRow = (cells, opts = {}) => {
      if (y + rowH > bottomLimit - 90) {
        close(segTop, y);
        doc.addPage();
        segTop = doc.page.margins.top;
        y = header(segTop);
      }
      if (opts.wash) doc.rect(left, y, width, rowH).fill(opts.wash);
      cols.forEach((c, i) => {
        doc.fillColor(opts.ink || INK)
          .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8)
          .text(String(cells[c.key] ?? '—'), colX[i] + pad, y + 5,
            { width: c.w * width - pad * 2, align: c.align || 'left', lineBreak: false });
      });
      doc.strokeColor(RULE).lineWidth(0.5)
        .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
      y += rowH;
    };

    if (!rows.length) {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(emptyText, left + pad, y + 5, { width: width - pad * 2, lineBreak: false });
      y += rowH;
    } else {
      rows.forEach((r) => writeRow(r.cells, r));
    }
    if (totalRow) writeRow(totalRow, { bold: true, wash: HEADER_BG });

    close(segTop, y);
    doc.y = y + 16;
  }

  // ── 1. Order lines ──────────────────────────────────────────────
  drawTable({
    title: 'ORDER LINES',
    cols: [
      { key: 'name',        label: 'Elastic',          w: 0.26 },
      { key: 'ordered',     label: 'Ordered (m)',      w: 0.13, align: 'right' },
      { key: 'produced',    label: 'Produced (m)',     w: 0.13, align: 'right' },
      { key: 'packed',      label: 'Packed (m)',       w: 0.13, align: 'right' },
      // Two questions, kept apart. "Not assigned" is a planning figure:
      // how much has no job raised against it. "Pending" is a delivery
      // figure: how much the customer is still owed. A line can be fully
      // assigned and entirely pending, which is why one number for both
      // told nobody anything.
      { key: 'notAssigned', label: 'Not assigned (m)', w: 0.16, align: 'right' },
      { key: 'pending',     label: 'Pending (m)',      w: 0.13, align: 'right' },
      { key: 'pct',         label: 'Packed %',         w: 0.06, align: 'right' },
    ],
    rows: (data.lines || []).map((l) => ({
      // A line with nothing left to deliver is done; one still owed
      // carries a wash and bold, so it reads as outstanding without
      // relying on colour. Owed — not unassigned — is what makes a line
      // outstanding, so the wash follows the delivery figure.
      bold: l.pendingDelivery > 0,
      wash: l.pendingDelivery > 0 ? ALERT_BG : undefined,
      cells: {
        name: l.name,
        ordered: _num(l.ordered),
        produced: _num(l.produced),
        packed: _num(l.packed),
        notAssigned: l.notAssigned > 0 ? _num(l.notAssigned) : '—',
        pending: l.pendingDelivery > 0 ? _num(l.pendingDelivery) : '—',
        pct: `${l.packedPct}%`,
      },
    })),
    totalRow: {
      name: 'TOTAL',
      ordered: _num(data.totals?.ordered),
      produced: _num(data.totals?.produced),
      packed: _num(data.totals?.packed),
      notAssigned: _num(data.totals?.notAssigned),
      pending: _num(data.totals?.pendingDelivery),
      pct: `${data.totals?.packedPct ?? 0}%`,
    },
    emptyText: 'No elastic lines on this order.',
  });

  // ── 2. Job status ───────────────────────────────────────────────
  drawTable({
    title: 'JOB STATUS',
    cols: [
      { key: 'jobNo',    label: 'Job',       w: 0.09 },
      { key: 'date',     label: 'Date',      w: 0.13 },
      { key: 'status',   label: 'Stage',     w: 0.13 },
      { key: 'machine',  label: 'Machine',   w: 0.10 },
      { key: 'warping',  label: 'Warping',   w: 0.13 },
      { key: 'covering', label: 'Covering',  w: 0.13 },
      { key: 'planned',  label: 'Planned',   w: 0.10, align: 'right' },
      { key: 'produced', label: 'Produced',  w: 0.10, align: 'right' },
      { key: 'packed',   label: 'Packed',    w: 0.09, align: 'right' },
    ],
    rows: (data.jobs || []).map((j) => ({
      cells: {
        jobNo: j.jobNo,
        date: j.date || '—',
        status: j.status,
        machine: j.machine,
        warping: j.warping,
        covering: j.covering,
        planned: _num(j.planned),
        produced: _num(j.produced),
        packed: _num(j.packed),
      },
    })),
    totalRow: {
      jobNo: 'TOTAL',
      date: '',
      status: '',
      machine: '',
      warping: '',
      covering: '',
      planned: _num(data.jobTotals?.planned),
      produced: _num(data.jobTotals?.produced),
      packed: _num(data.jobTotals?.packed),
    },
    emptyText: 'No jobs have been raised against this order yet.',
  });

  // ── 3. Production recorded ──────────────────────────────────────
  drawTable({
    title: 'PRODUCTION RECORDED ON THE FLOOR',
    cols: [
      { key: 'jobNo',    label: 'Job',              w: 0.12 },
      { key: 'elastics', label: 'Elastic',          w: 0.34 },
      { key: 'mode',     label: 'Mode',             w: 0.16 },
      { key: 'shifts',   label: 'Shifts',           w: 0.10, align: 'right' },
      { key: 'meters',   label: 'Shift output (m)', w: 0.16, align: 'right' },
      { key: 'produced', label: 'Job produced (m)', w: 0.12, align: 'right' },
    ],
    rows: (data.jobs || []).map((j) => ({
      cells: {
        jobNo: j.jobNo,
        elastics: j.elastics || '—',
        mode: j.productionMode === 'outsource'
          ? `Outsourced${j.outsourceVendor ? ` · ${j.outsourceVendor}` : ''}`
          : 'In-house',
        shifts: _num(j.shiftCount),
        meters: _num(j.shiftMeters),
        produced: _num(j.produced),
      },
    })),
    totalRow: {
      jobNo: 'TOTAL',
      elastics: '',
      mode: '',
      shifts: '',
      meters: _num(data.jobTotals?.shiftMeters),
      produced: _num(data.jobTotals?.produced),
    },
    emptyText: 'No production has been recorded against this order.',
  });

  // ── 4. Pending position ─────────────────────────────────────────
  // Two different things, kept apart on purpose. PENDING is what the
  // customer is still owed — ordered less packed. NOT ASSIGNED is what
  // no job has been raised for. Adding them together would hide which
  // one needs a decision, and they answer to different people.
  const pendY = doc.y;
  const cellW = width / 3;
  box(doc, left, pendY, width, 44);
  doc.strokeColor(RULE).lineWidth(0.6)
    .moveTo(left + cellW, pendY).lineTo(left + cellW, pendY + 44).stroke()
    .moveTo(left + cellW * 2, pendY).lineTo(left + cellW * 2, pendY + 44).stroke();

  boxLabel(doc, 'Pending (ordered less packed)', left + 6, pendY + 6, cellW - 12);
  boxValue(doc, `${_num(data.totals?.pendingDelivery)} m`, left + 6, pendY + 17, cellW - 12,
    { bold: true, fontSize: 11 });

  boxLabel(doc, 'Not assigned to jobs', left + cellW + 6, pendY + 6, cellW - 12);
  boxValue(doc, `${_num(data.unplanned)} m`, left + cellW + 6, pendY + 17, cellW - 12,
    { bold: true, fontSize: 11, color: data.unplanned > 0 ? ALERT_INK : INK });

  boxLabel(doc, 'Packed against order', left + cellW * 2 + 6, pendY + 6, cellW - 12);
  boxValue(doc, `${_num(data.totals?.packed)} m  (${data.totals?.packedPct ?? 0}%)`,
    left + cellW * 2 + 6, pendY + 17, cellW - 12, { bold: true, fontSize: 11 });
  doc.y = pendY + 54;

  if (data.unplanned > 0) {
    doc.fillColor(ALERT_INK).font('Helvetica-Bold').fontSize(8)
      .text(
        `${_num(data.unplanned)} m of this order is not assigned to any job yet.`,
        left, doc.y, { width, lineBreak: false }
      );
    doc.y += 14;
  }

  // ── Signature strip ─────────────────────────────────────────────
  const sigY = Math.max(doc.y + 12, bottomLimit - 70);
  signatureStrip(doc, left, sigY, width, ['Prepared by', 'Production', 'Approved by']);

  // ── Footer on every page ────────────────────────────────────────
  const range = doc.bufferedPageRange();
  const genLabel = `Generated ${new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Written inside the bottom margin with that margin zeroed, so pdfkit
    // does not read it as overflow and spawn a blank continuation page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - savedBottom + 22;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(genLabel, left, fy, { width: width / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, fy,
      { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  return _bufferFromDoc(doc);
}

module.exports = { buildOrderStatusPdf };
