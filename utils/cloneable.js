'use strict';
// ══════════════════════════════════════════════════════════════════
//  DATA THAT SURVIVES THE TRIP TO A WORKER THREAD
//
//  Anything sent to a worker is copied by structured clone, which keeps
//  own enumerable fields and drops prototypes. For plain objects, Dates
//  and Buffers that is exact. For what this codebase actually passes
//  around, it is not:
//
//    • a Mongoose document arrives as its internals — `$__`, `_doc`,
//      `$isNew` — so `template.elements` is simply undefined over there;
//    • an ObjectId arrives as an object with a byte buffer in it, and
//      `${id}` prints "[object Object]" on a delivery challan.
//
//  toCloneable turns a value into the shape the renderer would have SEEN
//  on the main thread: documents become their plain objects (virtuals
//  included, since a renderer may read one), ObjectIds become the hex
//  string they print as, Decimal128 becomes its string, functions are
//  dropped. Dates and Buffers pass through untouched.
// ══════════════════════════════════════════════════════════════════

function isMongooseDoc(v) {
  return v && typeof v.toObject === 'function' && v.$__ !== undefined;
}

function toCloneable(value, seen = new WeakMap()) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'function' || t === 'symbol') return undefined;
  if (t !== 'object') return value;

  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  const bson = value._bsontype;
  if (bson === 'ObjectId' || bson === 'ObjectID') return value.toHexString();
  if (bson === 'Decimal128' || bson === 'Long' || bson === 'Int32' || bson === 'Double') return value.toString();

  if (isMongooseDoc(value)) {
    return toCloneable(value.toObject({ virtuals: true, getters: false, depopulate: false }), seen);
  }

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) {
      const c = toCloneable(item, seen);
      out.push(c === undefined ? null : c);
    }
    return out;
  }

  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(k, toCloneable(v, seen));
    return out;
  }

  const out = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    const c = toCloneable(v, seen);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

module.exports = { toCloneable };
