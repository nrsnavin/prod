'use strict';
// ══════════════════════════════════════════════════════════════════
//  ASK JARVIS → THE REPORT ENGINE
//
//  Jarvis had thirteen hand-written lookups, so "production by operator
//  last week" or "sales to the Tirupur group this quarter" had no answer.
//  This gives it one more tool: write the question as the report engine's
//  simple SQL, run it with the asker's own role, and hand back the figures
//  — plus the query itself, so the screen can open it as a report to
//  download as PDF or Excel, or save.
//
//  Nothing new is trusted: the SQL goes through the same parser and the
//  same per-role dataset check as the Reports page (money datasets are
//  for admin and accounts), and it only ever reads.
// ══════════════════════════════════════════════════════════════════

const engine = {
  datasets: require('./reportEngine/datasets'),
  query: require('./reportEngine/query'),
  sql: require('./reportEngine/sql'),
  range: require('./reportEngine/range'),
};

// The same roles the /reports route lets in (app.js: gate('production', 'accounts')).
const REPORT_ROLES = new Set(['admin', 'production', 'accounts']);
const ROWS_FOR_MODEL = 25;

const roleOf = (user) => (user?.role === 'admin' ? 'admin' : user?.role);
const mayReport = (user) => REPORT_ROLES.has(roleOf(user));

/** The tool, described with the datasets this user may read; null if none. */
function toolFor(user) {
  if (!mayReport(user)) return null;
  const sets = engine.datasets.describe(roleOf(user));
  if (!sets.length) return null;
  const catalogue = sets.map((d) => `${d.id}${d.dated ? ' (dated)' : ' (as of today)'}: ${d.fields.map((f) => `${f.key}${f.type === 'money' ? '₹' : f.type === 'number' ? '#' : ''}`).join(', ')}`).join('\n');
  return {
    name: 'run_report',
    description:
      'Answer any question about figures across the business by running a report. Write ONE read-only query in this SQL: ' +
      "SELECT field | SUM/COUNT/AVG/MIN/MAX(field) [AS name] | COUNT(*) | COUNT(DISTINCT field) FROM <dataset> " +
      "[WHERE cond AND cond … using = != < <= > >= LIKE 'x%' IN (…) BETWEEN a AND b IS NULL] [GROUP BY …] [ORDER BY … DESC] [LIMIT n]. " +
      'No joins, no OR, no sub-queries. Use the period (preset, or from/to as YYYY-MM-DD) for dates rather than a WHERE on date. ' +
      'Fields marked ₹ are rupees, # are quantities. Datasets and fields you may use:\n' + catalogue,
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The query' },
        title: { type: 'string', description: 'A short name for the report, e.g. "Production by operator"' },
        preset: { type: 'string', enum: engine.range.PRESETS.filter((p) => p !== 'custom'), description: 'The period; default this month' },
        from: { type: 'string', description: 'YYYY-MM-DD, with to, for a custom period' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['sql'],
    },
  };
}

/** Run it as `user`: the figures for the model, and the report for the screen. */
async function run(input, user) {
  if (!mayReport(user)) return { error: "You don't have access to reports." };
  const sql = String(input?.sql || '').trim();
  if (!sql) return { error: 'No query given.' };
  if (sql.length > 4000) return { error: 'The query is too long.' };
  let query;
  try { query = engine.sql.parse(sql); } catch (err) { return { error: `The query did not read: ${err.message}` }; }
  const custom = input.from && input.to;
  const period = custom ? { preset: 'custom', from: String(input.from), to: String(input.to) } : { preset: engine.range.PRESETS.includes(input.preset) && input.preset !== 'custom' ? input.preset : 'month' };
  let range;
  try { range = engine.range.resolve(period); } catch (err) { return { error: err.message }; }
  let result;
  try {
    result = await engine.query.run(query, { role: roleOf(user), from: range.from, to: range.to, maxRows: 5000 });
  } catch (err) {
    return { error: err.status === 403 || err.statusCode === 403 ? "That data is not open to your role." : `The report could not run: ${err.message}` };
  }
  const dated = engine.datasets.DATASETS[result.dataset]?.dated;
  const title = String(input.title || '').trim().slice(0, 80) || result.datasetLabel;
  const rangeLabel = dated ? range.label : 'As of today';
  return {
    forModel: {
      title, period: rangeLabel, dataset: result.dataset,
      columns: result.columns.map((c) => `${c.key}${c.type === 'money' ? ' (₹)' : ''}`),
      rows: result.rows.slice(0, ROWS_FOR_MODEL),
      rowCount: result.rowCount,
      totals: result.totals,
      ...(result.rowCount > ROWS_FOR_MODEL ? { note: `Only the first ${ROWS_FOR_MODEL} of ${result.rowCount} rows are shown here; the full report opens from the answer.` } : {}),
    },
    report: { title, sql, query, period, rangeLabel, dataset: result.dataset, rowCount: result.rowCount, columns: result.columns, rows: result.rows.slice(0, 10), totals: result.totals },
  };
}

module.exports = { toolFor, run, mayReport, REPORT_ROLES };
