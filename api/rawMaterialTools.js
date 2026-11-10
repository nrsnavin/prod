"use strict";
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIALS — PICKER, PRICES, STOCK-TAKE SHEET, DUPLICATES, COMMAND  (part of /api/v2/materials)
//
//    GET   /materialForNewElastic
//    POST  /bulk-update-prices
//    GET   /stock-take.xlsx
//    POST  /stock-take/preview
//    GET   /duplicates
//    GET   /similar
//    POST  /merge
//    POST  /command
//
//  api/rawMaterial.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express           = require("express");
const mongoose          = require("mongoose");
const RawMaterial       = require("../models/RawMaterial");
const { TEXT_MODEL } = require("../utils/anthropicClient");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { recipeMaterialFilters } = require("../utils/recipeMaterials");
const { maybeFirePriceChangeAlert } = require("../utils/inventoryAlerts");
// ══════════════════════════════════════════════════════════════════
//  STOCK TAKE ON A SHEET
//
//    GET  /stock-take.xlsx?ids=a,b&category=   the count sheet: Ref,
//         Material, Category, Unit, and a blank "Counted stock" column
//         to fill on the rack (the figures the system holds are left
//         off on purpose — a blind count)
//    POST /stock-take/preview   multipart "file" — the filled sheet,
//         read back: each row matched to its material (by Ref, else by
//         name), the counted figure beside the live stock and the
//         difference. Writes nothing: the screen shows the differences
//         and posts them through /bulk-adjust-stock, each a ledger entry,
//         as the on-screen stock take does.
// ══════════════════════════════════════════════════════════════════
const ExcelJS = require("exceljs");
const multer = require("multer");
const { keepRequestContext } = require("../middleware/userContext");
// ══════════════════════════════════════════════════════════════
//  ONE YARN ENTERED MORE THAN ONCE  (services/materialDedupe.js)
//    GET  /duplicates             likely duplicates, a standard name each
//    GET  /similar?name=&category=&exclude=   "did you mean" while typing
//    POST /merge { into, from[], name, proposedName }   admin only
// ══════════════════════════════════════════════════════════════
const materialDedupe = require("../services/materialDedupe");
const { isAdmin: mustBe } = require("../middleware/auth");
const aiLedgerForMerge = require("../services/aiLedger");
const { promptVersion: mergePromptVersion } = require("../utils/aiPrompts");
const router = express.Router();

// ══════════════════════════════════════════════════════════════
//  11. MATERIAL FOR NEW ELASTIC  (legacy)
// ══════════════════════════════════════════════════════════════
//  Four buckets, matched CASE-INSENSITIVELY and by group link as well
//  as by name.
//
//  This used to be four find({ category: "warp" }) queries matching the
//  literal string — note "Rubber" capitalised and the other three not.
//  Two consequences, both silent:
//
//    • Editing a group's name case in the master emptied the matching
//      picker. No error, no empty-state message — the elastic form just
//      offered no warp yarns, and the recipe went in blank.
//    • The mobile app has always offered a "Chemicals" category the web
//      never had. Those materials matched none of the four and were
//      invisible to this endpoint entirely.
//
//  The buckets themselves stay hardcoded on purpose: an elastic has
//  exactly four composition slots, and they are a property of the cloth
//  rather than of the group list. What is no longer hardcoded is which
//  materials fall into each — that comes from the groups, so renaming
//  one in Settings moves its materials here too. The rules live in
//  utils/recipeMaterials.js, shared with the bulk-upload Excel template.
router.get(
  "/materialForNewElastic",
  catchAsyncErrors(async (req, res, next) => {
    const filters = await recipeMaterialFilters();
    const query = (bucket) =>
      RawMaterial.find({ archived: { $ne: true }, ...filters[bucket] }).sort({ name: 1 });

    const [warp, rubber, weft, covering] = await Promise.all([
      query("warp"), query("rubber"), query("weft"), query("covering"),
    ]);
    res.status(200).json({ warp, weft, rubber, covering });
  })
);

// ══════════════════════════════════════════════════════════════
//  BULK UPDATE PRICES
//  POST /materials/bulk-update-prices
//
//  Body:
//  {
//    updates: [{ _id, price }],   // only materials whose price changed
//    reason: "Monthly revision"   // shown in price history
//  }
//
//  • Skips materials where price hasn't actually changed
//  • Appends a priceHistory entry for each change
//  • Returns { success, updated: N, skipped: N, results: [...] }
// ══════════════════════════════════════════════════════════════
router.post(
  "/bulk-update-prices",
  catchAsyncErrors(async (req, res, next) => {
    const { updates = [], reason = "Bulk price update" } = req.body;

    if (updates.length > 500) {
      return next(new ErrorHandler("updates exceeds the 500-item limit per request", 400));
    }

    if (!Array.isArray(updates) || updates.length === 0) {
      return next(new ErrorHandler("updates array is required", 400));
    }

    // Validate all entries first
    for (const u of updates) {
      if (!u._id) return next(new ErrorHandler("Each update must have _id", 400));
      if (u.price === undefined || u.price === null || isNaN(Number(u.price))) {
        return next(new ErrorHandler(`Invalid price for material ${u._id}`, 400));
      }
      if (Number(u.price) < 0) {
        return next(new ErrorHandler(`Price cannot be negative for ${u._id}`, 400));
      }
    }

    const results  = [];
    let   skipped  = 0;

    // Process in parallel
    await Promise.all(
      updates.map(async (u) => {
        const material = await RawMaterial.findById(u._id).select("name price priceHistory");
        if (!material) { skipped++; return; }

        const newPrice = Number(u.price);
        const oldPrice = Number(material.price);

        // Skip if price hasn't changed
        if (newPrice === oldPrice) { skipped++; return; }

        await RawMaterial.findByIdAndUpdate(u._id, {
          $set:  { price: newPrice },
          $push: {
            priceHistory: {
              price:     newPrice,
              oldPrice,
              changedAt: new Date(),
              reason:    reason.trim() || "Bulk price update",
            },
          },
        });

        results.push({
          _id:      u._id,
          name:     material.name,
          oldPrice,
          newPrice,
          change:   +(newPrice - oldPrice).toFixed(4),
        });

        maybeFirePriceChangeAlert({
          material,
          oldPrice,
          newPrice,
          reason: reason || "Bulk price update",
        });
      })
    );

    res.status(200).json({
      success: true,
      message: `Updated ${results.length} price(s)`,
      updated: results.length,
      skipped,
      results,
    });
  })
);

const SHEET_NAME = "Stock take";
const SHEET_COLUMNS = ["Ref", "Material", "Category", "Unit", "Counted stock"];
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

/** The materials a sheet covers: everything not archived, narrowed by category or ids. */
function stockTakeFilter(query) {
  const filter = { archived: { $ne: true } };
  const category = String(query.category || "").trim();
  if (category && category !== "all") filter.category = category;
  const ids = String(query.ids || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) {
    if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw new ErrorHandler("ids contains an invalid id", 400);
    filter._id = { $in: ids };
  }
  return filter;
}

router.get(
  "/stock-take.xlsx",
  catchAsyncErrors(async (req, res, next) => {
    let filter;
    try { filter = stockTakeFilter(req.query); } catch (err) { return next(err); }
    const materials = await RawMaterial.find(filter).select("name category unit").sort({ category: 1, name: 1 }).lean();
    if (!materials.length) return next(new ErrorHandler("No materials to count — nothing matched.", 400));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "Ref", key: "ref", width: 28 },
      { header: "Material", key: "name", width: 40 },
      { header: "Category", key: "category", width: 16 },
      { header: "Unit", key: "unit", width: 8 },
      { header: "Counted stock", key: "counted", width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const m of materials) {
      const row = ws.addRow({ ref: String(m._id), name: m.name, category: m.category || "", unit: m.unit || "kg", counted: null });
      // The one column to fill, shaded so it is obvious on paper too.
      row.getCell("counted").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4CC" } };
      row.getCell("ref").font = { color: { argb: "FF888888" }, size: 9 };
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="stock-take-${stamp}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  })
);

const cellText = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    if (typeof v.text === "string") v = v.text;
    else if ("result" in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join("");
    else if (v instanceof Date) v = v.toISOString();
  }
  return String(v).trim();
};

router.post(
  "/stock-take/preview",
  keepRequestContext(sheetUpload.single("file")),
  catchAsyncErrors(async (req, res, next) => {
    if (!req.file?.buffer) return next(new ErrorHandler('Attach the filled sheet (field name "file").', 400));
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.file.buffer); } catch (_) {
      return next(new ErrorHandler("Could not read the file as an .xlsx workbook.", 400));
    }
    const ws = wb.getWorksheet(SHEET_NAME) || wb.worksheets[0];
    if (!ws) return next(new ErrorHandler("The workbook has no sheet.", 400));

    // The header row as the export wrote it; a sheet somebody made by
    // hand is read the same way as long as it names the columns.
    const col = {};
    ws.getRow(1).eachCell((cell, c) => { col[cellText(cell.value).toLowerCase()] = c; });
    const nameCol = col["material"] ?? col["name"];
    const countedCol = col["counted stock"] ?? col["counted"] ?? col["stock"];
    const refCol = col["ref"];
    if (!nameCol || !countedCol) {
      return next(new ErrorHandler('The sheet needs a "Material" column and a "Counted stock" column (download the sheet from here to get them).', 400));
    }

    const all = await RawMaterial.find({}).select("name category unit stock archived").lean();
    const byId = new Map(all.map((m) => [String(m._id), m]));
    const byName = new Map(all.map((m) => [String(m.name || "").trim().toLowerCase(), m]));

    const rows = [];
    const unknown = [];
    const errors = [];
    let blank = 0;
    const seen = new Set();
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      const name = cellText(row.getCell(nameCol).value);
      const ref = refCol ? cellText(row.getCell(refCol).value) : "";
      if (!name && !ref) return;
      const m = (ref && mongoose.Types.ObjectId.isValid(ref) && byId.get(ref)) || byName.get(name.toLowerCase());
      if (!m) { unknown.push({ row: rn, name: name || ref }); return; }
      const raw = cellText(row.getCell(countedCol).value);
      if (raw === "") { blank += 1; return; }
      const counted = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(counted) || counted < 0) { errors.push({ row: rn, name: m.name, error: `"${raw}" is not a quantity` }); return; }
      if (seen.has(String(m._id))) { errors.push({ row: rn, name: m.name, error: "listed twice on the sheet" }); return; }
      seen.add(String(m._id));
      const systemStock = Number(m.stock) || 0;
      rows.push({
        _id: String(m._id), name: m.name, category: m.category || "", unit: m.unit || "kg", archived: !!m.archived,
        systemStock, counted: Math.round(counted * 10000) / 10000,
        adjustment: Math.round((counted - systemStock) * 10000) / 10000,
      });
    });

    res.json({
      success: true,
      file: req.file.originalname || "",
      rows, blank, unknown, errors,
      changed: rows.filter((r) => r.adjustment !== 0).length,
    });
  })
);

router.get(
  "/duplicates",
  catchAsyncErrors(async (_req, res) => {
    res.json({ success: true, groups: await materialDedupe.groups() });
  })
);

router.get(
  "/similar",
  catchAsyncErrors(async (req, res) => {
    const exclude = mongoose.Types.ObjectId.isValid(String(req.query.exclude || "")) ? String(req.query.exclude) : undefined;
    res.json({ success: true, similar: await materialDedupe.similarTo(String(req.query.name || "").slice(0, 120), String(req.query.category || ""), exclude) });
  })
);

router.post(
  "/merge",
  mustBe("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { into, from, name, proposedName } = req.body || {};
    const ids = Array.isArray(from) ? from.map(String) : [];
    if (!mongoose.Types.ObjectId.isValid(String(into || "")) || !ids.length || ids.length > 20 || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return next(new ErrorHandler("Say which material to keep and which to merge into it", 400));
    }
    if (name != null && (typeof name !== "string" || name.length > 120)) return next(new ErrorHandler("name must be text, at most 120 characters", 400));
    const result = await materialDedupe.merge({ into, from: ids, name, by: req.user?._id });
    // The proposal scored against what was kept: the name, and the members.
    if (typeof proposedName === "string" && proposedName.trim()) {
      const id = await aiLedgerForMerge.record({
        surface: "material-dedupe", model: "rules", promptVersion: mergePromptVersion("material-dedupe"),
        refType: "RawMaterial", refId: result.kept._id, proposed: { name: proposedName.trim() },
      });
      if (id) await aiLedgerForMerge.settle(id, { accepted: { name: result.kept.name }, decidedBy: req.user?._id, expectSurface: "material-dedupe", ignoreMissing: true }).catch(() => {});
    }
    res.json({ success: true, ...result });
  })
);

// ══════════════════════════════════════════════════════════════
//  POST /command { text }   (services/storesCommand.js)
//    A storekeeper's spoken or typed line — "issue 20 kg 40s black to
//    job 512" — read into a draft movement. Nothing moves: the screen
//    confirms it through /bulk-adjust-stock, with the job attached.
// ══════════════════════════════════════════════════════════════
router.post(
  "/command",
  catchAsyncErrors(async (req, res, next) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return next(new ErrorHandler("Say or type what moved", 400));
    if (text.length > 300) return next(new ErrorHandler("Keep it to one line", 400));
    const out = await require("../services/storesCommand").read(text);
    const ledger = require("../services/aiLedger");
    const aiSuggestion = await ledger.record({
      surface: "stores-voice", model: out.by === "model" ? TEXT_MODEL : "rules", promptVersion: require("../utils/aiPrompts").promptVersion("stores-voice"),
      proposed: { action: out.draft.action, quantity: out.draft.quantity, material: out.draft.material?._id || null, job: out.draft.job?._id || null },
      usage: out.usage || undefined,
    });
    res.json({ success: true, draft: out.draft, problems: out.problems, by: out.by, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null });
  })
);

module.exports = router;
