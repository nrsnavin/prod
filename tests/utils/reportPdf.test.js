'use strict';

const { buildMorningDigestPdf, buildEveningReportPdf } =
  require("../../utils/reportPdf.js");
const { publishPdf, pdfFilename, REPORTS_DIR } =
  require("../../utils/reportPublisher.js");
const fs = require("fs");
const path = require("path");

const baseDigest = {
  dateLabel: "20 Jun 2026",
  production: { meters: 124000, shifts: 4 },
  wastage:    { meters: 320, penalty: 1500, entries: 3, topReason: "Yarn break" },
  stockouts:  [{ name: "Yarn-20s", stock: 12, daysToStockout: 2 }],
  maintenance: [{ ID: "M1", overdue: true, daysUntil: -2 }],
  predictedLate: [{ orderNo: 1042, customerName: "Acme", lateWorkingDays: 3 }],
  orderActivity: { edited: 1 },
  posteriorDrift: [{ machineLabel: "M3", elasticName: "ElasticA", dropPct: 32 }],
  attendance: { totalEffective: 22, present: 20, late: 2, halfDay: 0,
                absent: 3, onLeave: 1, percentOfBaseline: 95 },
  leave: { pending: 4 },
  complaints: { openCount: 3, newYesterday: 1 },
};

const baseEvening = {
  dateLabel: "20 Jun 2026",
  production: { meters: 56000, shifts: 2 },
  wastage:    { meters: 120, penalty: 0, entries: 1, topReason: null },
  deliveries: {
    count: 2, totalQuantity: 8500, totalAmount: 125000,
    items: [
      { dcNumber: "DC/E/26-27/041", orderNo: 1042,
        customerName: "Acme", totalQuantity: 5000 },
      { dcNumber: "DC/E/26-27/042", orderNo: null,
        customerName: "Bravo", totalQuantity: 3500 },
    ],
  },
};

describe("reportPdf.buildMorningDigestPdf", () => {
  test("returns a Buffer with a valid PDF header", async () => {
    const buf = await buildMorningDigestPdf(baseDigest);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("handles an all-clear day without crashing (no sections explode)", async () => {
    const buf = await buildMorningDigestPdf({
      dateLabel: "20 Jun 2026",
      production: { meters: 0, shifts: 0 },
      wastage: { meters: 0, penalty: 0, entries: 0, topReason: null },
      stockouts: [], maintenance: [], predictedLate: [],
      orderActivity: { edited: 0 }, posteriorDrift: [],
      attendance: { totalEffective: 0, present: 0, late: 0, halfDay: 0,
                    absent: 0, onLeave: 0, percentOfBaseline: null },
      leave: { pending: 0 },
      complaints: { openCount: 0, newYesterday: 0 },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("reportPdf.buildEveningReportPdf", () => {
  test("returns a Buffer with a valid PDF header", async () => {
    const buf = await buildEveningReportPdf(baseEvening);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("reportPublisher", () => {
  afterEach(async () => {
    // Tidy up anything the tests wrote.
    try {
      const entries = await fs.promises.readdir(REPORTS_DIR);
      await Promise.all(
        entries.filter((n) => n.startsWith("test-"))
          .map((n) => fs.promises.unlink(path.join(REPORTS_DIR, n))),
      );
    } catch { /* dir may not exist */ }
  });

  test("pdfFilename is date-derived plus 128 bits of random entropy", () => {
    const name = pdfFilename("test-thing", new Date("2026-06-20T08:30:00Z"));
    // prefix + minute-resolution timestamp + 32 hex chars (16 bytes).
    expect(name).toMatch(/^test-thing-2026-06-20-08-30-[0-9a-f]{32}\.pdf$/);
  });

  test("pdfFilename is unguessable — two calls with the same date differ", () => {
    const d = new Date("2026-06-20T08:30:00Z");
    expect(pdfFilename("r", d)).not.toBe(pdfFilename("r", d));
  });

  test("publishPdf writes the buffer + returns a URL ending in the filename", async () => {
    const buf = await buildEveningReportPdf(baseEvening);
    const out = await publishPdf(buf, "test-evening-write.pdf");
    expect(out.path).toMatch(/public\/reports\/test-evening-write\.pdf$/);
    expect(out.url).toMatch(/\/public\/reports\/test-evening-write\.pdf$/);
    const onDisk = await fs.promises.readFile(out.path);
    expect(onDisk.length).toBe(buf.length);
  });

  test("publishPdf URL respects PUBLIC_BASE_URL when set", async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://factory.example.com/";
    try {
      const buf = await buildEveningReportPdf(baseEvening);
      const out = await publishPdf(buf, "test-base-url.pdf");
      expect(out.url).toBe(
        "https://factory.example.com/public/reports/test-base-url.pdf"
      );
    } finally {
      if (prev == null) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prev;
    }
  });
});
