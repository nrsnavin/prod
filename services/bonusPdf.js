'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BONUS CERTIFICATE
//
//  Drawn here, away from the route that serves it (as the payslip is —
//  services/payslipPdf.js). The route finds the record; this is the page.
//
//    writeBonusCertificate(record, config, year, out)
//
//  The name, department, role and label are printed through latin1():
//  the built-in font has no Tamil, and a name written in it used to come
//  out as a row of the wrong letters.
// ══════════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');
const { latin1 } = require('../utils/pdfLatin');

/** "bonus-Ravi_Kumar-2026.pdf", and the name to fall back on when that cannot be sent. */
function bonusFileName(record, year) {
  return {
    name: `bonus-${record.employee?.name?.replace(/\s+/g, '_') || 'employee'}-${year}.pdf`,
    fallback: `bonus-${year}.pdf`,
  };
}

function writeBonusCertificate(record, config, year, out) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(out);

  doc.fillColor("#0D1B2A").rect(0, 0, doc.page.width, 110).fill();
  doc.fillColor("#FFFFFF")
     .font("Helvetica-Bold").fontSize(22)
     .text("Yearly Bonus Certificate", 50, 38);
  doc.font("Helvetica").fontSize(11).fillColor("#A8C0E0")
     .text(latin1(config?.bonusLabel) || `Annual Bonus ${year}`, 50, 70);
  if (config?.bonusDate) {
    doc.text(
      `Payout date: ${new Date(config.bonusDate).toLocaleDateString("en-IN", { day:"2-digit", month:"long", year:"numeric" })}`,
      50, 86
    );
  }

  doc.moveDown(3);
  doc.fillColor("#1B2B45").font("Helvetica-Bold").fontSize(13)
     .text("EMPLOYEE", 50, 140);
  doc.font("Helvetica").fontSize(12).fillColor("#0D1B2A")
     .text(`Name        : ${latin1(record.employee?.name) || "-"}`, 50, 160)
     .text(`Department  : ${latin1(record.employee?.department) || "-"}`)
     .text(`Role        : ${latin1(record.employee?.role) || "-"}`)
     .text(`Year        : ${year}`);

  doc.moveDown(1.5);
  doc.fillColor("#1B2B45").font("Helvetica-Bold").fontSize(13).text("BONUS DETAILS");
  doc.moveDown(0.5);
  const tableY = doc.y;
  const rows = [
    ["Hourly Rate",          `Rs. ${record.hourlyRate?.toFixed(2) || "0.00"}`],
    ["Hours Worked",         `${record.hoursWorked || 0} hrs`],
    ["Annual Earnings",      `Rs. ${record.annualEarnings?.toFixed(2) || "0.00"}`],
    ["Bonus Percent",        `${record.bonusPercent || 0}%`],
    ["Raw Bonus",            `Rs. ${record.rawBonusAmount?.toFixed(2) || "0.00"}`],
    ["Attendance Days",      `${record.attendanceDays || 0} / ${record.totalWorkingDays || 0}`],
    ["Attendance Rate",      `${record.attendanceRate?.toFixed(1) || 0}%`],
    ["Attendance Tier",      `${record.attendanceTier || "C"} (x${record.multiplier || 0})`],
  ];
  doc.font("Helvetica").fontSize(11).fillColor("#0D1B2A");
  rows.forEach((r, i) => {
    const y = tableY + (i * 18);
    doc.text(r[0], 60, y, { width: 200 });
    doc.text(r[1], 280, y, { width: 250 });
  });

  const bannerY = tableY + (rows.length * 18) + 20;
  doc.fillColor("#1D6FEB").rect(50, bannerY, doc.page.width - 100, 70).fill();
  doc.fillColor("#FFFFFF").font("Helvetica").fontSize(12)
     .text("FINAL BONUS PAYABLE", 70, bannerY + 12);
  doc.font("Helvetica-Bold").fontSize(28)
     .text(`Rs. ${record.bonusAmount?.toLocaleString("en-IN") || "0"}`, 70, bannerY + 30);

  const statusY = bannerY + 90;
  const statusColor = record.status === "paid" ? "#15803D" : "#D97706";
  doc.fillColor(statusColor).font("Helvetica-Bold").fontSize(12)
     .text(`Status: ${record.status?.toUpperCase() || "PENDING"}`, 50, statusY);
  if (record.status === "paid" && record.paidAt) {
    doc.fillColor("#475569").font("Helvetica").fontSize(10)
       .text(`Paid on ${new Date(record.paidAt).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })}`,
            50, statusY + 16);
  }

  doc.fillColor("#94A3B8").font("Helvetica").fontSize(9)
     .text(
       "This is a system-generated certificate. For queries contact your supervisor.",
       50, doc.page.height - 70, { width: doc.page.width - 100, align: "center" }
     );

  doc.end();
}

module.exports = { writeBonusCertificate, bonusFileName };
