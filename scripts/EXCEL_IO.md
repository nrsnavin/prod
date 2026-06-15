# Raw Material & Elastic — Excel import / export

`scripts/excel-io.js` moves Raw Materials and Elastics in and out of the
database through a single Excel workbook. **The export format and the
import format are identical**, so you can export the live data, edit it
in Excel, and re-import it.

Everything cross-references by **name**, never by Mongo `_id`. That is
what makes the linking work without you ever seeing a database id.

## The workbook

| Sheet | Key | Notes |
|-------|-----|-------|
| `Suppliers` | `name` | Every supplier a raw material points at must exist here or already in the DB. |
| `RawMaterials` | `name` | Points at a supplier via `supplierName`. |
| `Elastics` | `name` | One row per elastic. Points at raw materials by name in the `*_material` columns (`warpSpandex_material`, `spandexCovering_material`, `weftYarn_material`). |
| `ElasticWarpYarns` | `elasticName` | An elastic can have **many** warp yarns, so each warp yarn is one row here, linked back via `elasticName`. |

Fill them top to bottom — later sheets reference earlier ones.

## Dropdowns

The template and every export carry Excel **dropdowns** so linked
fields are a click, not a retype:

| Sheet.column | Dropdown source |
|--------------|-----------------|
| `RawMaterials.category` | fixed list: warp / weft / covering / Rubber / other |
| `RawMaterials.supplierName` | the `Suppliers` sheet `name` column |
| `Elastics.warpSpandex_material` / `spandexCovering_material` / `weftYarn_material` | the `RawMaterials` sheet `name` column |
| `ElasticWarpYarns.material` | the `RawMaterials` sheet `name` column |

Add a row on the source sheet (e.g. a new raw material) and it
appears in the dropdowns automatically — the lists point at a
1000-row range, not a fixed snapshot. The validation is *soft*: a
typed value that isn't in the list still imports (we resolve by exact
name and report anything that doesn't match), so the dropdowns help
without getting in the way.

> The **export** output is the **same** format with the same
> dropdowns, so `export` → edit → `import` round-trips cleanly.

## Commands

Run from the repo root (so `config/.env` loads and `MONGO_URL` is set):

```bash
# Blank workbook with just the headers (no DB needed):
node scripts/excel-io.js template  blank.xlsx

# Dump the live DB into a round-trippable workbook:
node scripts/excel-io.js export    backup-2026-06-15.xlsx

# Load a filled workbook into the DB:
node scripts/excel-io.js import     my-data.xlsx
```

## Import rules

- **Upsert by name.** Re-importing a row whose `name` already exists
  updates it in place; new names are created.
- **Weights are in grams** (used for costing). Ends / picks / hooks are
  counts.
- A `*_material` value must match a `RawMaterials.name` in the file or
  already in the DB. If any referenced material is missing, that elastic
  row is **reported and skipped** — nothing partially linked is written.
- Costing is recomputed on every elastic import using the same
  `utils/elasticCosting.js` the live `create-elastic` route uses, so the
  Costing collection stays in sync.

The import prints a summary and a list of any skipped rows with the
exact reason (e.g. `Elastic "25mm Black" warpSpandex: material "40D
Spandex" not found`).
