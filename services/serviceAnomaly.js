'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH SERVICE BILLS ARE WORTH LOOKING AT
//
//  Machine servicing is the easiest line in this business to pad. The
//  work happens on the floor, the person who signs it off is rarely the
//  person who watched it, the parts are specialist, and a bill for a
//  drive belt nobody can later find is indistinguishable from one for a
//  belt that was genuinely fitted.
//
//  ── What this is, and what it is NOT ──────────────────────────────
//  This finds PATTERNS THAT DESERVE A LOOK. It does not find fraud, and
//  nothing it produces is evidence of any. Every signal here has an
//  innocent explanation that is usually the true one: a loom serviced
//  three times in a fortnight may be a loom that is failing, and a
//  technician whose bills run high may be the only one trusted with the
//  difficult machines.
//
//  That is not a disclaimer bolted on afterwards — it decides the
//  design. The output is ranked observations with the evidence attached
//  and the innocent reading stated, never a verdict and never a label
//  on a person. A system that tells an owner "Rajan is stealing" on the
//  strength of a median will eventually be wrong about somebody's
//  livelihood.
//
//  ── Why robust statistics, not mean and standard deviation ────────
//  The obvious approach — flag anything more than 2σ from the mean —
//  fails on exactly the data it is meant to catch. Mean and standard
//  deviation are both dragged by outliers, so a large padded bill
//  inflates the mean it is being compared against AND widens the band
//  it has to escape. Enough of them and the fraud defines "normal".
//
//  Median and MAD (median absolute deviation) have a breakdown point of
//  50%: half the data would have to be bad before they move. So the
//  baselines here are medians, and deviation is measured in MADs.
//
//  ── How it learns ─────────────────────────────────────────────────
//  Nothing here is a hardcoded threshold about money or time. Every
//  baseline is computed from THIS plant's own history:
//
//    • the usual gap between services, per machine and overall
//    • the usual cost of a service, by type
//    • the usual cost per technician, compared against their peers
//
//  So a plant whose looms are serviced monthly and one whose looms are
//  serviced twice a year both get sensible answers with no
//  configuration, and both adapt as their own habits change.
//
//  It also learns from being told it is wrong. A finding that somebody
//  dismisses is recorded, and the same pattern on the same subject is
//  suppressed afterwards — see ServiceAnomalyFeedback. An alarm that
//  cannot be switched off gets ignored wholesale, which is worse than
//  no alarm.
//
//  ── The floor ─────────────────────────────────────────────────────
//  Below MIN_HISTORY services there are no baselines worth having, and
//  the honest output is "not enough history yet" rather than confident
//  nonsense from four data points. Same rule as the complaint themes.
// ══════════════════════════════════════════════════════════════════

const Machine = require('../models/Machine');
const MachineServiceBill = require('../models/MachineServiceBill');
const ServiceAnomalyFeedback = require('../models/ServiceAnomalyFeedback');

// ── Floors ─────────────────────────────────────────────────────────
/** Below this many service logs the plant has no baseline worth using. */
const MIN_HISTORY = 12;
/** A technician needs this many jobs before they are compared to peers. */
const MIN_PER_TECHNICIAN = 4;
/** An issue must recur on this many DIFFERENT machines to be a pattern. */
const MIN_MACHINES_FOR_ISSUE = 3;

// ── Shape of the answer ────────────────────────────────────────────
/** How far past the baseline something has to be before it is raised. */
const MAD_THRESHOLD = 3.5;
/** MAD → σ for a normal distribution; makes the score readable. */
const MAD_TO_SIGMA = 1.4826;

const round = (v, dp = 2) => {
  const f = 10 ** dp;
  return Math.round((Number(v) || 0) * f) / f;
};

const DAY = 24 * 60 * 60 * 1000;

// ── Robust statistics ──────────────────────────────────────────────

function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Median absolute deviation — the median of the distances from the
 * median. Unlike a standard deviation it is not moved by the outliers
 * it exists to find.
 */
function mad(values) {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * How far `value` sits from the middle of `values`, in robust units.
 *
 * Returns null when the sample cannot support a judgement at all, which
 * is a different answer from zero and must not be flattened into one.
 */
function robustScore(value, values) {
  if (values.length < 4) return null;
  const m = median(values);
  const d = mad(values);
  if (m === null || d === null) return null;

  // ── When the sample is unanimous ────────────────────────────────
  //  MAD of 0 means every observation agrees. Dividing by it is
  //  arithmetic rather than insight, and the first version of this
  //  returned null — which had the detector give up on the CLEAREST
  //  case there is. A plant that services every loom exactly every 60
  //  days, with one serviced every 5, is unanimous data with an
  //  obvious outlier, and saying nothing about it is the detector
  //  being defeated by consistency.
  //
  //  So a unanimous sample gets a scale from the median's own
  //  magnitude instead: 1% of it. Small enough that a real outlier
  //  clears the threshold easily, large enough that ₹1001 against a
  //  unanimous ₹1000 does not.
  const scale = d > 0 ? d * MAD_TO_SIGMA : Math.abs(m) * 0.01;

  // A unanimous sample centred on zero has no scale at all to borrow.
  // Only an exact match is unremarkable; anything else is unjudgeable.
  if (scale === 0) return value === m ? 0 : null;

  return (value - m) / scale;
}

// ── Normalising free text ──────────────────────────────────────────

/**
 * A description reduced to what it is ABOUT, so "replaced drive belt",
 * "Drive-belt replacement" and "changed the drive belt" collapse
 * together.
 *
 * Deliberately crude. The point is to notice that the same words keep
 * appearing, not to understand them, and a clever matcher that
 * occasionally groups two unrelated jobs would put a name beside a
 * finding it does not belong to.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'on', 'at', 'with',
  'was', 'were', 'is', 'are', 'been', 'be', 'it', 'its', 'this', 'that',
  'replaced', 'replacement', 'replace', 'changed', 'change', 'changing',
  'repair', 'repaired', 'repairing', 'fixed', 'fix', 'fixing', 'done',
  'service', 'serviced', 'servicing', 'new', 'old', 'again',
]);

function issueKey(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  // Sorted and de-duplicated so word order does not split a group.
  return [...new Set(words)].sort().join(' ');
}

// ── Gathering the history ──────────────────────────────────────────

/**
 * Every service log in the window, flattened across machines, with its
 * bills attached.
 */
async function history(windowDays) {
  const since = new Date(Date.now() - windowDays * DAY);

  const machines = await Machine.find({})
    .select('ID manufacturer serviceLogs')
    .lean();

  const bills = await MachineServiceBill.find({})
    .select('-data')
    .lean();

  const billsByLog = new Map();
  for (const b of bills) {
    const key = String(b.serviceLog);
    if (!billsByLog.has(key)) billsByLog.set(key, []);
    billsByLog.get(key).push(b);
  }

  const logs = [];
  for (const m of machines) {
    for (const log of m.serviceLogs || []) {
      const date = log.date ? new Date(log.date) : null;
      if (!date || date < since) continue;

      const attached = billsByLog.get(String(log._id)) || [];
      const billTotal = attached.reduce((s, b) => s + (Number(b.amount) || 0), 0);

      logs.push({
        logId:      String(log._id),
        machineId:  String(m._id),
        machineID:  m.ID || '',
        date,
        type:       log.type || 'Other',
        description: log.description || '',
        technician: String(log.technician || '').trim(),
        // The logged cost is what somebody typed; the bills are what was
        // actually filed. Where they disagree the bills are the harder
        // number, so they win — and the disagreement is itself a signal.
        cost:       billTotal > 0 ? billTotal : Number(log.cost) || 0,
        loggedCost: Number(log.cost) || 0,
        billTotal,
        bills:      attached,
      });
    }
  }

  logs.sort((a, b) => a.date - b.date);
  return { logs, machines };
}

// ══════════════════════════════════════════════════════════════════
//  THE SIGNALS
//
//  Each returns findings shaped the same way:
//
//    { kind, subject, severity, title, detail, innocent, evidence }
//
//  `innocent` is not decoration. It is the reading that is usually
//  true, printed beside the finding so nobody reads a statistic as an
//  accusation.
// ══════════════════════════════════════════════════════════════════

/** 0..1, from how many robust units past the threshold something sits. */
function severityFrom(score) {
  const excess = Math.abs(score) - MAD_THRESHOLD;
  if (excess <= 0) return 0;
  // Saturating rather than linear: past a point "much worse than
  // normal" stops being a useful distinction.
  return round(Math.min(1, excess / (MAD_THRESHOLD * 2)), 3);
}

/**
 * 1 · A machine serviced far more often than this plant services
 *     machines.
 *
 * Measured on the GAP between consecutive services, against the gaps
 * seen across the whole floor. A short gap is the thing a padded second
 * visit produces, and also the thing a genuinely failing loom produces.
 */
function repeatServices(logs) {
  const byMachine = new Map();
  for (const l of logs) {
    if (!byMachine.has(l.machineId)) byMachine.set(l.machineId, []);
    byMachine.get(l.machineId).push(l);
  }

  // The plant's own idea of a normal gap, pooled across every machine.
  const allGaps = [];
  for (const [, ls] of byMachine) {
    for (let i = 1; i < ls.length; i++) {
      allGaps.push((ls[i].date - ls[i - 1].date) / DAY);
    }
  }
  const usual = median(allGaps);
  if (usual === null || allGaps.length < 4) return [];

  const findings = [];
  for (const [machineId, ls] of byMachine) {
    if (ls.length < 3) continue;

    const gaps = [];
    for (let i = 1; i < ls.length; i++) {
      gaps.push((ls[i].date - ls[i - 1].date) / DAY);
    }
    const machineGap = median(gaps);
    // Only a SHORTER-than-usual gap is interesting. A machine serviced
    // rarely is not a billing pattern.
    const score = robustScore(machineGap, allGaps);
    if (score === null || score > -MAD_THRESHOLD) continue;

    const spend = ls.reduce((sum, l) => sum + l.cost, 0);
    findings.push({
      kind:    'repeat-service',
      subject: machineId,
      severity: severityFrom(score),
      title:   `${ls[0].machineID} is serviced far more often than the rest of the floor`,
      detail:
        `${ls.length} services in this window, typically ${round(machineGap, 0)} days ` +
        `apart against ${round(usual, 0)} days across the plant. ` +
        `₹${Math.round(spend).toLocaleString('en-IN')} spent.`,
      innocent:
        'A loom that is genuinely failing is serviced often, and that is ' +
        'the usual reason for this. Worth comparing against its output.',
      evidence: ls.map((l) => ({
        logId: l.logId, date: l.date, type: l.type,
        technician: l.technician, cost: l.cost, description: l.description,
      })),
    });
  }
  return findings;
}

/**
 * 2 · The same issue recurring across many different machines.
 *
 * One part failing on one loom is maintenance. The same part billed
 * across a third of the floor in a quarter is either a bad batch — well
 * worth knowing — or a line item nobody checks.
 */
function issueAcrossMachines(logs) {
  const byIssue = new Map();
  for (const l of logs) {
    const key = issueKey(l.description);
    if (!key) continue;
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key).push(l);
  }

  const findings = [];
  for (const [key, ls] of byIssue) {
    const machines = new Set(ls.map((l) => l.machineId));
    if (machines.size < MIN_MACHINES_FOR_ISSUE) continue;

    const spend = ls.reduce((sum, l) => sum + l.cost, 0);
    const technicians = [...new Set(ls.map((l) => l.technician).filter(Boolean))];

    // One technician behind the whole pattern is the version worth
    // looking at first; several is much more likely a real bad batch.
    const oneHand = technicians.length === 1 && ls.length >= 4;

    findings.push({
      kind:    'issue-across-machines',
      subject: key,
      severity: oneHand ? 0.6 : 0.3,
      title:   `The same job has been billed on ${machines.size} machines`,
      detail:
        `"${ls[0].description}" and ${ls.length - 1} like it, across ` +
        `${machines.size} machines, ₹${Math.round(spend).toLocaleString('en-IN')} in total` +
        (oneHand ? `, all by ${technicians[0]}.` : '.'),
      innocent:
        'Identical looms wear identically, so a common part failing across ' +
        'the floor is normal — and a bad batch of that part is worth ' +
        'finding for its own sake.',
      evidence: ls.map((l) => ({
        logId: l.logId, machineID: l.machineID, date: l.date,
        technician: l.technician, cost: l.cost, description: l.description,
      })),
    });
  }
  return findings;
}

/**
 * 3 · A technician whose jobs cost markedly more than their peers'.
 *
 * Compared like against like: the median cost of THIS technician's jobs
 * against the median of every technician's median. Comparing raw bills
 * would only discover who does the expensive work.
 */
function technicianCost(logs) {
  const byTech = new Map();
  for (const l of logs) {
    if (!l.technician) continue;
    if (!byTech.has(l.technician)) byTech.set(l.technician, []);
    byTech.get(l.technician).push(l);
  }

  const eligible = [...byTech.entries()].filter(
    ([, ls]) => ls.length >= MIN_PER_TECHNICIAN
  );
  if (eligible.length < 3) return [];   // nobody to compare against

  const medians = eligible.map(([, ls]) => median(ls.map((l) => l.cost)));

  const findings = [];
  for (const [tech, ls] of eligible) {
    const own = median(ls.map((l) => l.cost));
    const score = robustScore(own, medians);
    if (score === null || score < MAD_THRESHOLD) continue;

    const spend = ls.reduce((sum, l) => sum + l.cost, 0);
    findings.push({
      kind:    'technician-cost',
      subject: tech,
      severity: severityFrom(score),
      title:   `${tech}'s jobs cost more than other technicians'`,
      detail:
        `Typically ₹${Math.round(own).toLocaleString('en-IN')} a job against ` +
        `₹${Math.round(median(medians)).toLocaleString('en-IN')} for the others, ` +
        `over ${ls.length} jobs totalling ₹${Math.round(spend).toLocaleString('en-IN')}.`,
      innocent:
        'The technician trusted with the difficult machines will always ' +
        'bill more than one who does routine work. Check WHICH jobs ' +
        'before reading anything into the figure.',
      evidence: ls.map((l) => ({
        logId: l.logId, machineID: l.machineID, date: l.date,
        cost: l.cost, type: l.type, description: l.description,
      })),
    });
  }
  return findings;
}

/**
 * 4 · The same bill number, or the same amount from the same vendor on
 *     the same day, filed more than once.
 *
 * The one signal here that is closer to fact than pattern: a bill
 * number is supposed to be unique to the vendor who issued it, so the
 * same one against two machines is either a filing mistake or a bill
 * claimed twice. Both need fixing.
 */
function duplicateBills(logs) {
  const byNumber = new Map();
  const byAmountDay = new Map();

  for (const l of logs) {
    for (const b of l.bills) {
      const amount = Number(b.amount) || 0;
      if (amount <= 0) continue;

      const no = String(b.billNo || '').trim().toLowerCase();
      const vendor = String(b.vendor || '').trim().toLowerCase();

      if (no) {
        const key = `${vendor}|${no}`;
        if (!byNumber.has(key)) byNumber.set(key, []);
        byNumber.get(key).push({ log: l, bill: b });
      }
      if (vendor && b.billDate) {
        const day = new Date(b.billDate).toISOString().slice(0, 10);
        const key = `${vendor}|${day}|${amount}`;
        if (!byAmountDay.has(key)) byAmountDay.set(key, []);
        byAmountDay.get(key).push({ log: l, bill: b });
      }
    }
  }

  const findings = [];

  for (const [key, rows] of byNumber) {
    if (rows.length < 2) continue;
    findings.push({
      kind:    'duplicate-bill-no',
      subject: key,
      severity: 0.9,
      title:   `Bill ${rows[0].bill.billNo} is filed ${rows.length} times`,
      detail:
        `The same bill number from ${rows[0].bill.vendor || 'the same vendor'} ` +
        `appears against ${new Set(rows.map((r) => r.log.machineID)).size} machine(s), ` +
        `₹${Math.round(rows.reduce((s, r) => s + (Number(r.bill.amount) || 0), 0)).toLocaleString('en-IN')} in total.`,
      innocent:
        'Usually the same document uploaded twice, or one invoice that ' +
        'genuinely covered several machines and was filed against each.',
      evidence: rows.map((r) => ({
        logId: r.log.logId, machineID: r.log.machineID,
        billNo: r.bill.billNo, vendor: r.bill.vendor,
        amount: r.bill.amount, billDate: r.bill.billDate,
      })),
    });
  }

  for (const [key, rows] of byAmountDay) {
    if (rows.length < 2) continue;
    // Already reported through the stronger bill-number signal.
    const numbers = new Set(rows.map((r) => String(r.bill.billNo || '').trim()));
    if (numbers.size === 1 && [...numbers][0]) continue;

    findings.push({
      kind:    'duplicate-bill-amount',
      subject: key,
      severity: 0.5,
      title:   `${rows.length} identical amounts from one vendor on one day`,
      detail:
        `₹${Math.round(Number(rows[0].bill.amount) || 0).toLocaleString('en-IN')} from ` +
        `${rows[0].bill.vendor} on ${new Date(rows[0].bill.billDate).toLocaleDateString('en-IN')}, ` +
        `filed ${rows.length} times.`,
      innocent:
        'A vendor doing the same job on several looms in a day bills the ' +
        'same amount for each, which is exactly what this looks like.',
      evidence: rows.map((r) => ({
        logId: r.log.logId, machineID: r.log.machineID,
        billNo: r.bill.billNo, vendor: r.bill.vendor,
        amount: r.bill.amount, billDate: r.bill.billDate,
      })),
    });
  }

  return findings;
}

/**
 * 5 · A logged cost that does not match the bills filed against it.
 *
 * Not a statistic at all — two numbers that are supposed to agree and
 * do not. Included here because it is the cheapest thing on the list to
 * check and the easiest to fix.
 */
function costMismatch(logs) {
  return logs
    .filter((l) => l.loggedCost > 0 && l.billTotal > 0
      && Math.round(l.loggedCost) !== Math.round(l.billTotal))
    .map((l) => ({
      kind:    'cost-mismatch',
      subject: l.logId,
      severity: 0.4,
      title:   `${l.machineID}: the bills and the logged cost disagree`,
      detail:
        `Logged ₹${Math.round(l.loggedCost).toLocaleString('en-IN')}, ` +
        `bills total ₹${Math.round(l.billTotal).toLocaleString('en-IN')}.`,
      innocent:
        'Usually a cost typed from memory before the bill arrived, or a ' +
        'bill that has not been uploaded yet.',
      evidence: [{
        logId: l.logId, machineID: l.machineID, date: l.date,
        technician: l.technician, loggedCost: l.loggedCost, billTotal: l.billTotal,
      }],
    }));
}

/**
 * Everything, ranked, with dismissed findings removed.
 *
 * @param {number} windowDays how far back to look
 */
async function analyse(windowDays = 365) {
  const { logs } = await history(windowDays);

  if (logs.length < MIN_HISTORY) {
    // Saying "no problems found" from eight service logs would be a
    // confident claim resting on nothing.
    return {
      ready: false,
      reason: `Only ${logs.length} services on record in this window. ` +
              `Patterns need at least ${MIN_HISTORY} before they mean anything.`,
      windowDays,
      services: logs.length,
      findings: [],
    };
  }

  const findings = [
    ...duplicateBills(logs),
    ...repeatServices(logs),
    ...technicianCost(logs),
    ...issueAcrossMachines(logs),
    ...costMismatch(logs),
  ].filter((f) => f.severity > 0);

  // What somebody has already looked at and explained.
  const dismissed = await ServiceAnomalyFeedback.find({
    expiresAt: { $gt: new Date() },
  }).select('kind subject').lean();
  const silenced = new Set(dismissed.map((d) => `${d.kind}|${d.subject}`));

  const kept = findings.filter((f) => !silenced.has(`${f.kind}|${f.subject}`));
  kept.sort((a, b) => b.severity - a.severity);

  return {
    ready: true,
    windowDays,
    services: logs.length,
    dismissed: findings.length - kept.length,
    findings: kept,
  };
}

// ══════════════════════════════════════════════════════════════════
//  WHAT IS BEING SPENT
// ══════════════════════════════════════════════════════════════════

/** "2026-08" — the bucket a date falls in. */
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

/**
 * Every month in the window, INCLUDING the ones with no spending.
 *
 * A chart drawn only from months that had a bill silently closes the
 * gaps, so three quiet months and a spike read as four steady ones. The
 * quiet months are the shape of the data, not missing data.
 */
function monthsBetween(from, to) {
  const out = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

/**
 * Monthly service spending, optionally for one machine.
 *
 * @param {number} windowDays
 * @param {string|null} machineId  restrict to one machine
 */
async function spending(windowDays = 365, machineId = null) {
  const { logs } = await history(windowDays);
  const mine = machineId
    ? logs.filter((l) => l.machineId === String(machineId))
    : logs;

  const from = new Date(Date.now() - windowDays * DAY);
  const buckets = new Map(monthsBetween(from, new Date()).map((m) => [m, {
    month: m, total: 0, services: 0, labour: 0, parts: 0,
  }]));

  for (const l of mine) {
    const key = monthKey(l.date);
    const bucket = buckets.get(key);
    if (!bucket) continue;   // a log dated outside the window
    bucket.total    += l.cost;
    bucket.services += 1;
    // Split by what the bill was FOR where bills exist, so a month of
    // spare parts reads differently from a month of labour.
    for (const b of l.bills) {
      const amount = Number(b.amount) || 0;
      if (b.kind === 'spare_bill') bucket.parts += amount;
      else bucket.labour += amount;
    }
  }

  const series = [...buckets.values()].map((b) => ({
    month:    b.month,
    total:    round(b.total),
    labour:   round(b.labour),
    parts:    round(b.parts),
    services: b.services,
  }));

  const total = round(series.reduce((s, b) => s + b.total, 0));
  const months = series.length || 1;

  // By type and by technician — the two cuts somebody actually asks for.
  const byType = {};
  const byTechnician = {};
  for (const l of mine) {
    byType[l.type] = round((byType[l.type] || 0) + l.cost);
    const t = l.technician || 'Unrecorded';
    byTechnician[t] = round((byTechnician[t] || 0) + l.cost);
  }

  return {
    windowDays,
    series,
    total,
    services: mine.length,
    // The MEDIAN month, not the mean: one rebuild does not become the
    // number somebody budgets against for the rest of the year.
    typicalMonth: round(median(series.map((b) => b.total)) ?? 0),
    meanMonth: round(total / months),
    byType: Object.entries(byType)
      .map(([type, amount]) => ({ type, amount }))
      .sort((a, b) => b.amount - a.amount),
    byTechnician: Object.entries(byTechnician)
      .map(([technician, amount]) => ({ technician, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/**
 * The most expensive machines to keep running, ranked.
 *
 * Cost alone would only find the machines that are serviced; cost per
 * service is added so a loom with one enormous rebuild is legible
 * beside one with twenty small visits.
 */
async function costliestMachines(windowDays = 365, limit = 10) {
  const { logs } = await history(windowDays);

  const byMachine = new Map();
  for (const l of logs) {
    if (!byMachine.has(l.machineId)) {
      byMachine.set(l.machineId, {
        machineId: l.machineId, machineID: l.machineID,
        total: 0, services: 0, lastServiced: null,
      });
    }
    const row = byMachine.get(l.machineId);
    row.total += l.cost;
    row.services += 1;
    if (!row.lastServiced || l.date > row.lastServiced) row.lastServiced = l.date;
  }

  return [...byMachine.values()]
    .map((r) => ({
      ...r,
      total: round(r.total),
      perService: round(r.total / (r.services || 1)),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

module.exports = {
  MIN_HISTORY,
  MIN_PER_TECHNICIAN,
  MIN_MACHINES_FOR_ISSUE,
  MAD_THRESHOLD,
  median,
  mad,
  robustScore,
  issueKey,
  history,
  round,
  DAY,
  severityFrom,
  repeatServices,
  issueAcrossMachines,
  technicianCost,
  duplicateBills,
  costMismatch,
  analyse,
  spending,
  costliestMachines,
  monthsBetween,
  monthKey,
  ServiceAnomalyFeedback,
};
