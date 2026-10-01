'use strict';

// ══════════════════════════════════════════════════════════════════
//  CHECKED AT THE DOOR
//
//  Each route used to check its own inputs by hand, and the checks
//  differed: one trimmed, one didn't; one took a number where it wanted
//  text and crashed calling .trim() on it; one let a 5 MB string through
//  to be hashed. `validate({ body, query, params })` runs a zod schema
//  before the handler:
//
//    • a value of the wrong type or size is refused with 400, saying
//      which field and why, before any handler code runs;
//    • fields the schema doesn't name are dropped from req.body, so a
//      request can't smuggle in a field a handler might later read;
//    • numbers that arrive as text ("12") and text that arrives as a
//      number (a phone typed into a numeric field) become what the
//      handler expects.
//
//  What a schema does NOT do is replace a handler's own rules. Missing
//  fields are mostly optional here, because the handlers already answer
//  them in their own words ("Enter the metres produced"); the schema is
//  the type-and-size gate in front of that.
//
//  The refusal is { message, code: "INVALID_INPUT", details: { issues } }
//  through the normal error handler, so clients that branch on `code`
//  can show the field.
// ══════════════════════════════════════════════════════════════════

const { z } = require('zod');
const ErrorHandler = require('../utils/ErrorHandler');

const KIND = { string: 'text', number: 'a number', boolean: 'yes or no', array: 'a list', object: 'a set of fields' };

function describe(issue) {
  const field = issue.path.length ? issue.path.join('.') : 'request';
  if (issue.code === 'invalid_type') {
    if (issue.received === 'undefined') return `${field} is required`;
    return `${field} must be ${KIND[issue.expected] || issue.expected}`;
  }
  if (issue.code === 'too_big' && issue.type === 'string') return `${field} is too long (at most ${issue.maximum} characters)`;
  if (issue.code === 'too_big' && issue.type === 'array') return `${field} has too many entries (at most ${issue.maximum})`;
  return `${field}: ${issue.message}`;
}

/** Express middleware: check `body`, `query` and `params` against schemas. */
function validate(schemas) {
  const validateRequest = (req, _res, next) => {
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const issues = result.error.issues.slice(0, 10).map((i) => ({ field: i.path.join('.'), message: describe(i) }));
        const err = new ErrorHandler(issues[0].message, 400);
        err.code = 'INVALID_INPUT';
        err.details = { issues };
        return next(err);
      }
      // Only the body is replaced: Express owns req.query and req.params,
      // and the handlers read those as strings anyway.
      if (part === 'body') req.body = result.data;
    }
    next();
  };
  validateRequest.isRequestValidator = true; // for tests/api/validationCoverage.test.js
  return validateRequest;
}

// ── Field types shared by the schemas ──────────────────────────────
const text = (max = 200) => z.string().max(max);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
/** Text, or a number sent where text was meant (a phone, a PIN). */
const textish = (max = 50) => z.union([z.string().max(max), z.number()]).transform((v) => String(v));
/** A number, or one sent as text ("12.5"). Empty text is left for the handler. */
const numberish = z.union([z.number(), z.string().max(30)]);

const fields = { text, objectId, textish, numberish };

module.exports = { validate, fields, z };
