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

const INVOICE_FIELDS = [
  { key: "companyName", label: "Company name" },
  { key: "tagline", label: "Tagline" },
  { key: "companyAddress", label: "Company address" },
  { key: "companyGstin", label: "Company GSTIN" },
  { key: "companyContact", label: "Company phone/email" },
  { key: "docTitle", label: "Document title" },
  { key: "docNo", label: "Document no." },
  { key: "docDate", label: "Document date" },
  { key: "partyName", label: "Party name" },
  { key: "partyAddress", label: "Party address" },
  { key: "partyGstin", label: "Party GSTIN" },
  { key: "totalQty", label: "Total quantity" },
  { key: "totalAmount", label: "Total amount" },
  { key: "footerNote", label: "Footer note" },
  { key: "termsText", label: "Terms & conditions" },
];

const INVOICE_COLUMNS = [
  { field: "sno", header: "#", width: 0.5, align: "left", format: "text" },
  { field: "description", header: "Description", width: 3, align: "left", format: "text" },
  { field: "qty", header: "Qty", width: 1, align: "right", format: "number" },
  { field: "rate", header: "Rate", width: 1, align: "right", format: "currency" },
  { field: "amount", header: "Amount", width: 1, align: "right", format: "currency" },
];

function invoiceSample(title) {
  return {
    fields: {
      companyName: "Balu Elastics",
      tagline: "Elastic Manufacturing",
      companyAddress: "12 Mill Road, Erode, Tamil Nadu 638001",
      companyGstin: "33ABCDE1234F1Z5",
      companyContact: "+91 98765 43210  ·  hello@baluelastics.com",
      docTitle: title,
      docNo: "DC-2026-0042",
      docDate: "22-Jul-2026",
      partyName: "Sunrise Garments Pvt Ltd",
      partyAddress: "48 Textile Park, Tiruppur 641604",
      partyGstin: "33AAExx9999F1Z2",
      totalQty: "1,250",
      totalAmount: "₹86,500",
      footerNote: "This is a computer-generated document.",
      termsText: "Goods once dispatched will not be taken back. Subject to Erode jurisdiction.",
    },
    rows: [
      { sno: 1, description: '3/4" Woven Elastic — White', qty: 500, rate: 42, amount: 21000 },
      { sno: 2, description: '1" Knitted Elastic — Black', qty: 450, rate: 55, amount: 24750 },
      { sno: 3, description: '2" Jacquard Elastic — Navy', qty: 300, rate: 68, amount: 20400 },
    ],
    logo: "", // pulled from DocumentSettings at render time
  };
}

// A4 portrait = 595 x 842 pt. Starter letterhead + party block + table.
function invoiceStarter() {
  return [
    { id: "logo", type: "image", x: 40, y: 36, w: 90, h: 42 },
    { id: "company", type: "field", field: "companyName", x: 140, y: 38, w: 300, h: 22, fontSize: 18, bold: true, color: "#1D6FEB", align: "left" },
    { id: "tagline", type: "field", field: "tagline", x: 140, y: 60, w: 300, h: 14, fontSize: 9, color: "#5A6A85" },
    { id: "addr", type: "field", field: "companyAddress", x: 40, y: 88, w: 300, h: 12, fontSize: 8, color: "#5A6A85" },
    { id: "gstin", type: "field", field: "companyGstin", x: 40, y: 100, w: 300, h: 12, fontSize: 8, color: "#5A6A85" },
    { id: "title", type: "field", field: "docTitle", x: 380, y: 40, w: 175, h: 22, fontSize: 16, bold: true, align: "right", color: "#0D1B2A" },
    { id: "docno", type: "field", field: "docNo", x: 380, y: 66, w: 175, h: 12, fontSize: 9, align: "right", color: "#5A6A85" },
    { id: "docdate", type: "field", field: "docDate", x: 380, y: 80, w: 175, h: 12, fontSize: 9, align: "right", color: "#5A6A85" },
    { id: "rule", type: "line", x: 40, y: 120, w: 515, h: 0, lineWidth: 1.5, color: "#1D6FEB" },
    { id: "billto", type: "text", text: "Bill To:", x: 40, y: 134, w: 100, h: 12, fontSize: 9, bold: true, color: "#0D1B2A" },
    { id: "party", type: "field", field: "partyName", x: 40, y: 148, w: 300, h: 14, fontSize: 11, bold: true },
    { id: "partyaddr", type: "field", field: "partyAddress", x: 40, y: 164, w: 300, h: 12, fontSize: 8, color: "#5A6A85" },
    { id: "table", type: "table", x: 40, y: 196, w: 515, h: 400, fontSize: 9, headerBg: "#1D6FEB", zebra: true, columns: INVOICE_COLUMNS },
    { id: "totlbl", type: "text", text: "Total:", x: 380, y: 610, w: 80, h: 14, fontSize: 10, bold: true, align: "right" },
    { id: "total", type: "field", field: "totalAmount", x: 465, y: 610, w: 90, h: 14, fontSize: 11, bold: true, align: "right", color: "#1D6FEB" },
    { id: "terms", type: "field", field: "termsText", x: 40, y: 660, w: 515, h: 30, fontSize: 8, color: "#5A6A85" },
    { id: "footer", type: "field", field: "footerNote", x: 40, y: 800, w: 515, h: 12, fontSize: 8, align: "center", color: "#8895A7" },
  ];
}

const DOC_TYPES = {
  "delivery-challan": {
    label: "Delivery Challan",
    fields: INVOICE_FIELDS,
    columns: INVOICE_COLUMNS,
    sample: () => invoiceSample("DELIVERY CHALLAN"),
    starter: invoiceStarter,
  },
  "purchase-order": {
    label: "Purchase Order",
    fields: INVOICE_FIELDS,
    columns: INVOICE_COLUMNS,
    sample: () => invoiceSample("PURCHASE ORDER"),
    starter: invoiceStarter,
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
