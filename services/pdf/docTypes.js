"use strict";

// ══════════════════════════════════════════════════════════════
//  PDF DOC-TYPE REGISTRY
//
//  Each document the visual designer supports declares:
//    label     — human name
//    fields    — the bindable data keys (drives the editor's field
//                palette and the {{field}} dropdown)
//    columns   — default table columns for the line-items grid
//    sample    — a realistic { fields, rows, logo } context so the
//                designer can render a live preview before the template
//                is wired to real documents
//
//  starterTemplate(docType) returns a non-blank default layout so a
//  fresh template opens with a usable letterhead + table.
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  DELIVERY CHALLAN
//
//  A challan accompanies goods; it is not a tax invoice. It carries no
//  rate, amount or value — which is why it does not share the invoice
//  field list or columns with the purchase order. What it does carry is
//  the dispatch detail a driver and a gate clerk need: vehicle, LR,
//  transporter, and the order the goods are against.
//
//  The layout is deliberately plain: hairline-ruled boxes, a grey header
//  band rather than a colour one, and a signature strip — the dense,
//  monochrome form style that reads as a shipping document rather than
//  as marketing.
// ══════════════════════════════════════════════════════════════

const DC_FIELDS = [
  { key: "companyName", label: "Company name" },
  { key: "tagline", label: "Tagline" },
  { key: "companyAddress", label: "Company address" },
  { key: "companyGstin", label: "Company GSTIN" },
  { key: "companyContact", label: "Company phone/email" },
  { key: "docTitle", label: "Document title" },
  { key: "docNo", label: "Challan no." },
  { key: "docDate", label: "Challan date" },
  { key: "partyName", label: "Consignee name" },
  { key: "partyAddress", label: "Consignee address" },
  { key: "partyGstin", label: "Consignee GSTIN" },
  { key: "partyContact", label: "Consignee phone" },
  { key: "orderNo", label: "Against order" },
  { key: "vehicleNo", label: "Vehicle no." },
  { key: "driverName", label: "Driver name" },
  { key: "transporter", label: "Transporter" },
  { key: "lrNumber", label: "LR / GC no." },
  { key: "remarks", label: "Remarks" },
  { key: "totalQty", label: "Total quantity" },
  { key: "lineCount", label: "Number of line items" },
  { key: "footerNote", label: "Footer note" },
  { key: "termsText", label: "Terms & conditions" },
];

// No rate, no amount. Quantity and unit are the whole commercial story a
// challan tells.
const DC_COLUMNS = [
  { field: "sno", header: "S.No", width: 0.6, align: "left", format: "text" },
  { field: "description", header: "Description of Goods", width: 4.4, align: "left", format: "text" },
  { field: "unit", header: "UOM", width: 0.9, align: "center", format: "text" },
  { field: "qty", header: "Quantity", width: 1.3, align: "right", format: "number" },
];

const INK = "#111111";
const MUTED = "#555555";
const RULE = "#999999";

function dcSample() {
  return {
    fields: {
      companyName: "Balu Elastics",
      tagline: "Elastic Manufacturing",
      companyAddress: "12 Mill Road, Erode, Tamil Nadu 638001",
      companyGstin: "33ABCDE1234F1Z5",
      companyContact: "+91 98765 43210  ·  hello@baluelastics.com",
      docTitle: "DELIVERY CHALLAN",
      docNo: "DC/2026/0042",
      docDate: "22-Jul-2026",
      partyName: "Sunrise Garments Pvt Ltd",
      partyAddress: "48 Textile Park, Tiruppur 641604",
      partyGstin: "33AAExx9999F1Z2",
      orderNo: "Order #1042",
      vehicleNo: "TN 33 BX 4417",
      driverName: "R. Murugan",
      transporter: "Sri Balaji Transports",
      lrNumber: "LR-88213",
      remarks: "Handle rolls flat — do not stack on edge.",
      totalQty: "1,250",
      lineCount: "3",
      footerNote: "This is a computer-generated document.",
      termsText: "Goods once dispatched will not be taken back. Subject to Erode jurisdiction.",
    },
    rows: [
      { sno: 1, description: '3/4" Woven Elastic — White', unit: "m", qty: 500 },
      { sno: 2, description: '1" Knitted Elastic — Black', unit: "m", qty: 450 },
      { sno: 3, description: '2" Jacquard Elastic — Navy', unit: "m", qty: 300 },
    ],
    logo: "",
  };
}

// A4 portrait = 595 x 842pt. A ruled form: framed header, boxed consignee
// and dispatch panes, gridded item table, signature strip.
function dcStarter() {
  const L = 34;              // left margin
  const R = 561;             // right edge
  const W = R - L;           // 527
  const MID = L + W / 2;     // pane split

  const label = (id, text, x, y, w) => ({
    id, type: "text", text, x, y, w, h: 10, fontSize: 6.5, bold: true, color: MUTED,
  });
  const value = (id, field, x, y, w, extra = {}) => ({
    id, type: "field", field, x, y, w, h: 12, fontSize: 9, color: INK, ...extra,
  });

  return [
    // ── Letterhead ────────────────────────────────────────────
    { id: "logo", type: "image", x: L + 4, y: 40, w: 74, h: 36 },
    { id: "company", type: "field", field: "companyName", x: L + 86, y: 40, w: 300, h: 20, fontSize: 15, bold: true, color: INK },
    { id: "tagline", type: "field", field: "tagline", x: L + 86, y: 58, w: 300, h: 11, fontSize: 7.5, color: MUTED },
    { id: "addr", type: "field", field: "companyAddress", x: L + 86, y: 70, w: 300, h: 11, fontSize: 7.5, color: MUTED },
    { id: "contact", type: "field", field: "companyContact", x: L + 86, y: 82, w: 300, h: 11, fontSize: 7.5, color: MUTED },
    { id: "cgstin", type: "field", field: "companyGstin", x: L + 86, y: 94, w: 300, h: 11, fontSize: 7.5, color: MUTED },

    // Title sits in its own ruled box, top-right — the SAP convention.
    { id: "titlebox", type: "box", x: 396, y: 38, w: R - 396, h: 26, lineWidth: 0.8, color: INK },
    { id: "title", type: "field", field: "docTitle", x: 400, y: 45, w: R - 404, h: 16, fontSize: 12, bold: true, align: "center", color: INK },

    // ── Document identity grid ────────────────────────────────
    { id: "idbox", type: "box", x: 396, y: 68, w: R - 396, h: 44, lineWidth: 0.6, color: RULE },
    label("l_no", "CHALLAN NO.", 401, 73, 80),
    value("v_no", "docNo", 401, 83, 80, { bold: true }),
    label("l_dt", "DATE", 486, 73, 70),
    value("v_dt", "docDate", 486, 83, 70),
    label("l_ord", "AGAINST ORDER", 401, 97, 155),
    value("v_ord", "orderNo", 401, 105, 155, { fontSize: 8 }),

    { id: "hrule", type: "line", x: L, y: 122, w: W, h: 0, lineWidth: 1.2, color: INK },

    // ── Consignee | Dispatch panes ────────────────────────────
    { id: "pane", type: "box", x: L, y: 132, w: W, h: 92, lineWidth: 0.6, color: RULE },
    { id: "panesplit", type: "line", x: MID, y: 132, w: 0, h: 92, lineWidth: 0.6, color: RULE },

    label("l_cons", "CONSIGNEE (SHIP TO)", L + 6, 138, 240),
    value("v_cons", "partyName", L + 6, 150, 240, { bold: true, fontSize: 10 }),
    value("v_consaddr", "partyAddress", L + 6, 165, 240, { fontSize: 8, color: MUTED }),
    value("v_consgst", "partyGstin", L + 6, 195, 240, { fontSize: 8, color: MUTED }),
    // The consignee's phone. A challan is handed to a driver who may need
    // to ring ahead; it was on the DC record but never on the paper.
    value("v_consph", "partyContact", L + 6, 208, 240, { fontSize: 8, color: MUTED }),

    label("l_disp", "DISPATCH DETAILS", MID + 6, 138, 240),
    label("l_veh", "VEHICLE NO.", MID + 6, 152, 110),
    value("v_veh", "vehicleNo", MID + 6, 161, 110),
    label("l_lr", "LR / GC NO.", MID + 128, 152, 110),
    value("v_lr", "lrNumber", MID + 128, 161, 110),
    label("l_tr", "TRANSPORTER", MID + 6, 178, 110),
    value("v_tr", "transporter", MID + 6, 187, 110),
    // Who is actually driving. Captured on the DC and, until now, only
    // ever visible on screen.
    label("l_drv", "DRIVER", MID + 128, 178, 110),
    value("v_drv", "driverName", MID + 128, 187, 110),
    label("l_rem", "REMARKS", MID + 6, 204, 232),
    value("v_rem", "remarks", MID + 6, 213, 232, { fontSize: 7.5, color: MUTED }),

    // ── Items ─────────────────────────────────────────────────
    {
      id: "table", type: "table", x: L, y: 236, w: W, h: 420, fontSize: 8.5,
      headerBg: "#E4E4E4", headerColor: INK, bodyColor: INK,
      gridColor: RULE, grid: true, zebra: false,
      columns: DC_COLUMNS,
    },

    // ── Totals strip ──────────────────────────────────────────
    { id: "totbox", type: "box", x: L, y: 664, w: W, h: 22, lineWidth: 0.6, color: RULE },
    { id: "totlines_l", type: "text", text: "Total line items:", x: L + 6, y: 671, w: 90, h: 12, fontSize: 8, color: MUTED },
    { id: "totlines", type: "field", field: "lineCount", x: L + 98, y: 671, w: 40, h: 12, fontSize: 9, bold: true, color: INK },
    { id: "totqty_l", type: "text", text: "TOTAL QUANTITY", x: 380, y: 671, w: 110, h: 12, fontSize: 8, bold: true, align: "right", color: MUTED },
    { id: "totqty", type: "field", field: "totalQty", x: 494, y: 670, w: R - 500, h: 14, fontSize: 11, bold: true, align: "right", color: INK },

    // ── Terms ─────────────────────────────────────────────────
    { id: "l_terms", type: "text", text: "TERMS & CONDITIONS", x: L, y: 698, w: 200, h: 10, fontSize: 6.5, bold: true, color: MUTED },
    { id: "terms", type: "field", field: "termsText", x: L, y: 709, w: 330, h: 40, fontSize: 7.5, color: MUTED },

    // ── Signature strip ───────────────────────────────────────
    { id: "sigbox", type: "box", x: L, y: 758, w: W, h: 52, lineWidth: 0.6, color: RULE },
    { id: "sigsplit1", type: "line", x: L + W / 3, y: 758, w: 0, h: 52, lineWidth: 0.6, color: RULE },
    { id: "sigsplit2", type: "line", x: L + (2 * W) / 3, y: 758, w: 0, h: 52, lineWidth: 0.6, color: RULE },
    { id: "sig1", type: "text", text: "Prepared by", x: L + 6, y: 796, w: 150, h: 10, fontSize: 7, color: MUTED },
    { id: "sig2", type: "text", text: "Checked by", x: L + W / 3 + 6, y: 796, w: 150, h: 10, fontSize: 7, color: MUTED },
    { id: "sig3", type: "text", text: "Receiver's signature & seal", x: L + (2 * W) / 3 + 6, y: 796, w: 165, h: 10, fontSize: 7, color: MUTED },

    // ── Footer ────────────────────────────────────────────────
    { id: "footer", type: "field", field: "footerNote", x: L, y: 818, w: 330, h: 10, fontSize: 7, color: MUTED },
    { id: "pageno", type: "pageNumber", text: "Page {{n}} of {{total}}", x: 380, y: 818, w: R - 380, h: 10, fontSize: 7, align: "right", color: MUTED },
  ];
}

// ══════════════════════════════════════════════════════════════
//  PURCHASE ORDER
//
//  Same ruled form as the challan, but a PO IS a commercial document:
//  it commits the company to a price, so rate and amount stay. The
//  parties are the other way round — we are the buyer, the supplier is
//  the party — and the totals block carries a value, not just a count.
// ══════════════════════════════════════════════════════════════

const PO_FIELDS = [
  { key: "companyName", label: "Company name" },
  { key: "tagline", label: "Tagline" },
  { key: "companyAddress", label: "Company address" },
  { key: "companyGstin", label: "Company GSTIN" },
  { key: "companyContact", label: "Company phone/email" },
  { key: "docTitle", label: "Document title" },
  { key: "docNo", label: "PO no. (prefixed)" },
  { key: "poNumber", label: "PO no. (bare)" },
  { key: "docDate", label: "PO date" },
  { key: "expectedDate", label: "Expected delivery (prefixed)" },
  { key: "expectedDelivery", label: "Expected delivery (bare)" },
  { key: "poStatus", label: "PO status" },
  { key: "raisedFor", label: "Raised for (job / order)" },
  { key: "partyName", label: "Supplier name" },
  { key: "partyAddress", label: "Supplier address" },
  { key: "partyGstin", label: "Supplier GSTIN" },
  { key: "partyContact", label: "Supplier phone/email" },
  { key: "totalQty", label: "Total quantity" },
  { key: "totalAmount", label: "Total amount" },
  { key: "lineCount", label: "Number of line items" },
  { key: "footerNote", label: "Footer note" },
  { key: "termsText", label: "Terms & conditions" },
];

const PO_COLUMNS = [
  { field: "sno", header: "S.No", width: 0.55, align: "left", format: "text" },
  { field: "description", header: "Material Description", width: 3.3, align: "left", format: "text" },
  { field: "unit", header: "UOM", width: 0.7, align: "center", format: "text" },
  { field: "qty", header: "Quantity", width: 1, align: "right", format: "number" },
  { field: "rate", header: "Rate", width: 1, align: "right", format: "currency" },
  { field: "amount", header: "Amount", width: 1.2, align: "right", format: "currency" },
];

function poSample() {
  return {
    fields: {
      companyName: "Balu Elastics",
      tagline: "Elastic Manufacturing",
      companyAddress: "12 Mill Road, Erode, Tamil Nadu 638001",
      companyGstin: "GSTIN: 33ABCDE1234F1Z5",
      companyContact: "+91 98765 43210  ·  hello@baluelastics.com",
      docTitle: "PURCHASE ORDER",
      docNo: "PO #1042",
      poNumber: "1042",
      docDate: "22-Jul-2026",
      expectedDelivery: "05-Aug-2026",
      poStatus: "approved",
      raisedFor: "For Job J-812  ·  Order #1042",
      partyName: "Coimbatore Yarn Traders",
      partyAddress: "7 Mettupalayam Road, Coimbatore 641002",
      partyGstin: "GSTIN: 33AAFCY1234K1Z9",
      partyContact: "+91 90000 11122  ·  sales@cbeyarn.in",
      totalQty: "1,900",
      totalAmount: "Rs. 1,86,500",
      lineCount: "3",
      footerNote: "This is a computer-generated document.",
      termsText: "Please quote our PO number on the invoice and delivery note. Subject to Erode jurisdiction.",
    },
    rows: [
      { sno: 1, description: "Nylon 40D — Semi-dull", unit: "kg", qty: 800, rate: 105, amount: 84000 },
      { sno: 2, description: "Spandex 70D", unit: "kg", qty: 600, rate: 118, amount: 70800 },
      { sno: 3, description: "Polyester 150D — Black", unit: "kg", qty: 500, rate: 63, amount: 31500 },
    ],
    logo: "",
  };
}

function poStarter() {
  const L = 34;
  const R = 561;
  const W = R - L;
  const MID = L + W / 2;

  const label = (id, text, x, y, w) => ({
    id, type: "text", text, x, y, w, h: 10, fontSize: 6.5, bold: true, color: MUTED,
  });
  const value = (id, field, x, y, w, extra = {}) => ({
    id, type: "field", field, x, y, w, h: 12, fontSize: 9, color: INK, ...extra,
  });

  return [
    // ── Letterhead — the buyer ────────────────────────────────
    { id: "logo", type: "image", x: L + 4, y: 40, w: 74, h: 36 },
    { id: "company", type: "field", field: "companyName", x: L + 86, y: 40, w: 300, h: 20, fontSize: 15, bold: true, color: INK },
    { id: "tagline", type: "field", field: "tagline", x: L + 86, y: 58, w: 300, h: 11, fontSize: 7.5, color: MUTED },
    { id: "addr", type: "field", field: "companyAddress", x: L + 86, y: 70, w: 300, h: 11, fontSize: 7.5, color: MUTED },
    { id: "contact", type: "field", field: "companyContact", x: L + 86, y: 82, w: 300, h: 11, fontSize: 7.5, color: MUTED },
    { id: "cgstin", type: "field", field: "companyGstin", x: L + 86, y: 94, w: 300, h: 11, fontSize: 7.5, color: MUTED },

    { id: "titlebox", type: "box", x: 396, y: 38, w: R - 396, h: 26, lineWidth: 0.8, color: INK },
    { id: "title", type: "field", field: "docTitle", x: 400, y: 45, w: R - 404, h: 16, fontSize: 12, bold: true, align: "center", color: INK },

    // ── Document identity grid ────────────────────────────────
    { id: "idbox", type: "box", x: 396, y: 68, w: R - 396, h: 46, lineWidth: 0.6, color: RULE },
    label("l_no", "P.O. NUMBER", 401, 73, 80),
    value("v_no", "poNumber", 401, 83, 80, { bold: true }),
    label("l_dt", "P.O. DATE", 486, 73, 70),
    value("v_dt", "docDate", 486, 83, 70),
    label("l_exp", "EXPECTED DELIVERY", 401, 95, 155),
    value("v_exp", "expectedDelivery", 401, 103, 155, { fontSize: 8 }),
    // Blank on a routine replenishment PO; on one raised from a job's
    // material shortfall it is the answer to "why did we buy this?".
    value("v_for", "raisedFor", 401, 114, 155, { fontSize: 7 }),

    { id: "hrule", type: "line", x: L, y: 124, w: W, h: 0, lineWidth: 1.2, color: INK },

    // ── Supplier | Deliver-to panes ───────────────────────────
    { id: "pane", type: "box", x: L, y: 134, w: W, h: 92, lineWidth: 0.6, color: RULE },
    { id: "panesplit", type: "line", x: MID, y: 134, w: 0, h: 92, lineWidth: 0.6, color: RULE },

    label("l_sup", "SUPPLIER", L + 6, 140, 240),
    value("v_sup", "partyName", L + 6, 152, 240, { bold: true, fontSize: 10 }),
    value("v_supaddr", "partyAddress", L + 6, 167, 240, { fontSize: 8, color: MUTED }),
    value("v_supcontact", "partyContact", L + 6, 195, 240, { fontSize: 8, color: MUTED }),
    value("v_supgst", "partyGstin", L + 6, 207, 240, { fontSize: 8, color: MUTED }),

    label("l_del", "DELIVER TO", MID + 6, 140, 240),
    value("v_delname", "companyName", MID + 6, 152, 240, { bold: true, fontSize: 10 }),
    value("v_deladdr", "companyAddress", MID + 6, 167, 240, { fontSize: 8, color: MUTED }),
    value("v_delgst", "companyGstin", MID + 6, 195, 240, { fontSize: 8, color: MUTED }),

    // ── Items ─────────────────────────────────────────────────
    {
      id: "table", type: "table", x: L, y: 238, w: W, h: 396, fontSize: 8.5,
      headerBg: "#E4E4E4", headerColor: INK, bodyColor: INK,
      gridColor: RULE, grid: true, zebra: false,
      columns: PO_COLUMNS,
    },

    // ── Totals ────────────────────────────────────────────────
    // Boxed and right-aligned: on a PO the value is the commitment, so it
    // gets the emphasis the challan's quantity total does not need.
    { id: "totbox", type: "box", x: 330, y: 640, w: R - 330, h: 40, lineWidth: 0.6, color: RULE },
    { id: "tqty_l", type: "text", text: "Total quantity", x: 336, y: 647, w: 110, h: 12, fontSize: 8, color: MUTED },
    { id: "tqty", type: "field", field: "totalQty", x: 446, y: 646, w: R - 452, h: 12, fontSize: 9, align: "right", color: INK },
    { id: "tamt_rule", type: "line", x: 330, y: 661, w: R - 330, h: 0, lineWidth: 0.6, color: RULE },
    { id: "tamt_l", type: "text", text: "TOTAL VALUE", x: 336, y: 667, w: 110, h: 12, fontSize: 8, bold: true, color: MUTED },
    { id: "tamt", type: "field", field: "totalAmount", x: 430, y: 665, w: R - 436, h: 16, fontSize: 12, bold: true, align: "right", color: INK },

    { id: "lines_l", type: "text", text: "Total line items:", x: L, y: 647, w: 90, h: 12, fontSize: 8, color: MUTED },
    { id: "lines", type: "field", field: "lineCount", x: L + 92, y: 647, w: 40, h: 12, fontSize: 9, bold: true, color: INK },

    // ── Terms ─────────────────────────────────────────────────
    { id: "l_terms", type: "text", text: "TERMS & CONDITIONS", x: L, y: 692, w: 200, h: 10, fontSize: 6.5, bold: true, color: MUTED },
    { id: "terms", type: "field", field: "termsText", x: L, y: 703, w: 290, h: 46, fontSize: 7.5, color: MUTED },

    // ── Signature strip ───────────────────────────────────────
    { id: "sigbox", type: "box", x: L, y: 758, w: W, h: 52, lineWidth: 0.6, color: RULE },
    { id: "sigsplit1", type: "line", x: L + W / 3, y: 758, w: 0, h: 52, lineWidth: 0.6, color: RULE },
    { id: "sigsplit2", type: "line", x: L + (2 * W) / 3, y: 758, w: 0, h: 52, lineWidth: 0.6, color: RULE },
    { id: "sig1", type: "text", text: "Prepared by", x: L + 6, y: 796, w: 150, h: 10, fontSize: 7, color: MUTED },
    { id: "sig2", type: "text", text: "Approved by", x: L + W / 3 + 6, y: 796, w: 150, h: 10, fontSize: 7, color: MUTED },
    { id: "sig3", type: "text", text: "Supplier acknowledgement", x: L + (2 * W) / 3 + 6, y: 796, w: 165, h: 10, fontSize: 7, color: MUTED },

    // ── Footer ────────────────────────────────────────────────
    { id: "footer", type: "field", field: "footerNote", x: L, y: 818, w: 330, h: 10, fontSize: 7, color: MUTED },
    { id: "pageno", type: "pageNumber", text: "Page {{n}} of {{total}}", x: 380, y: 818, w: R - 380, h: 10, fontSize: 7, align: "right", color: MUTED },
  ];
}

const DOC_TYPES = {
  "delivery-challan": {
    label: "Delivery Challan",
    fields: DC_FIELDS,
    columns: DC_COLUMNS,
    sample: dcSample,
    starter: dcStarter,
  },
  "purchase-order": {
    label: "Purchase Order",
    fields: PO_FIELDS,
    columns: PO_COLUMNS,
    sample: poSample,
    starter: poStarter,
  },
};

function listDocTypes() {
  return Object.entries(DOC_TYPES).map(([id, d]) => ({ id, label: d.label, fields: d.fields }));
}

function getDocType(id) {
  return DOC_TYPES[id] || null;
}

function starterTemplate(docType) {
  const d = DOC_TYPES[docType];
  return {
    docType,
    name: d ? d.label : docType,
    pageSize: "A4",
    orientation: "portrait",
    enabled: false,
    elements: d ? d.starter() : [],
  };
}

module.exports = { DOC_TYPES, listDocTypes, getDocType, starterTemplate };
