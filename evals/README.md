# Evals

Two of this system's AI features read something a person would otherwise
have to read, and hand the result to a person to check:

- **shift-sheet-ocr** — hand-written production, timer and remarks off a
  scanned shift sheet.
- **qc-vision** — visible defects on a photo of elastic tape.

The AI ledger (`services/aiLedger.js`) measures them *in production*: it
records what the model proposed and what the human saved, so the
acceptance rate on `GET /api/v2/health/ai` reflects real use. That is the
number that matters day to day.

This folder is the other half — a **fixed set of cases with known
answers**, so that a change (a new model, an edited prompt, an upstream
snapshot swap) can be tested *before* it reaches the floor rather than
noticed three weeks later in the acceptance rate.

## Why there are no sample cases in here

A golden set is real inputs with answers a person checked by eye.

Fabricated scans and made-up expected values would produce a number that
measures nothing and looks exactly like a number that measures
something — and somebody would eventually trust it. So `cases/` ships
empty, and the runner says so rather than printing a reassuring 100%.

Ten sheets will already tell you something. Twenty is a good set.

## Adding a case

A case is **two files that share a name**, in the folder for the surface:

```
evals/cases/shift-sheet-ocr/
  2026-08-14-day.pdf              ← the real scanned sheet
  2026-08-14-day.expected.json    ← what it actually says
```

### shift-sheet-ocr

Use a scan of a sheet you have already verified, and transcribe what is
written on it — not what the system currently reads.

```json
{
  "rows": {
    "SD-8F3A2C": { "production": 1240, "timer": "7:45:00", "remarks": "warp break 20m" },
    "SD-9B1E77": { "production": 980,  "timer": "6:10:00" }
  }
}
```

Notes:

- The key is the **printed Code** on the row, as printed.
- Omit a field you do not want graded. The second row above scores
  production and timer, and never counts remarks against the model —
  useful when the handwriting genuinely is unreadable and you do not
  want to pretend otherwise.
- `production` is an integer, `null` for a blank cell. A blank cell that
  the model fills in *is* an error and should be recorded as `null`.

### qc-vision

```json
{
  "overallResult": "fail",
  "defectCode": "weave-fault",
  "spec": {
    "name": "20mm knitted elastic",
    "parameters": [
      { "parameter": "Width (mm)", "expected": "20" },
      { "parameter": "Elongation (%)", "expected": "160" }
    ]
  }
}
```

`spec` is optional but makes the case realistic: the live route passes
the elastic's testing parameters, so an eval without them is scoring a
harder problem than the feature actually faces.

## Running

```bash
node scripts/run-evals.js                      # every surface with cases
node scripts/run-evals.js --surface qc-vision
node scripts/run-evals.js --save-baseline      # pin today's numbers
node scripts/run-evals.js --tolerance 3        # allow a 3-point drop
```

Exit codes: `0` pass, `1` regression against the baseline, `2` could not
run (no API key, no cases). A CI job can gate on this directly.

**This costs money.** Every run uploads every case to a vision model.
That is the point — but run it on a change, not on every commit.

## Reading the output

Recall and field accuracy are reported separately and never averaged,
because they fail differently:

- a row the OCR **missed** is obvious on screen and gets typed in;
- a row the OCR got **wrong** may not be noticed at all, and a wrong
  production figure flows into payroll, order progress and every rate
  estimate downstream.

The second is much worse than the first. A model that returns two rows
perfectly and skips the other 198 should not be able to report 100%, and
it cannot.

For QC vision, missed defects and false alarms are counted separately
and reported as counts rather than rates — with thirty photos, a
percentage invites more confidence than thirty photos can support.

## The baseline

`--save-baseline` stores the current numbers **alongside the model
strings and prompt versions that produced them**. A regression report
then prints what changed, because the first question is always "what
changed?" and a bare percentage cannot answer it.

A regression is a *drop* beyond the tolerance, never a change. Models get
better as well as worse, and failing on "different" would train everyone
to re-baseline reflexively — which is the same as having no baseline.

## Case inputs are gitignored by default

Scans and QC photos are real production data — a customer's order
numbers, an operator's handwriting, a photo of somebody's product. So
`.gitignore` already excludes the inputs (`*.pdf`, `*.jpg`, `*.png`, …
under `evals/cases/`), along with `baseline.json`, which is only
meaningful next to the cases that produced it.

The `.expected.json` answer keys **stay tracked**: they are small, they
are the part that took human effort, and they are useless to anyone
without the inputs. That way the shape of the golden set is reviewable
in a diff while its contents stay on the machine that has them.

`git add -f <file>` if a particular case is safe to share.
