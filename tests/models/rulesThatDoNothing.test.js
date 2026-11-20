'use strict';
// ══════════════════════════════════════════════════════════════════
//  A RULE WRITTEN ON A FIELD THAT CANNOT KEEP IT
//
//  `min` and `max` are rules for numbers and dates. Written on a text
//  field they are accepted and ignored: `name: { type: String, min: 2 }`
//  reads as "at least two letters" and checks nothing. The Customer
//  model carried a pair for years; three more models still did. A rule
//  nobody enforces is worse than none — the next reader believes it.
//
//  And a default that names one person: a packing with nobody recorded
//  as having checked or packed it was filed under a fixed employee id,
//  written into the model.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const dir = path.join(__dirname, '..', '..', 'models');
for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) require(path.join(dir, f));

/** Every path of a schema, into its sub-documents and arrays of them. */
function eachPath(schema, visit, prefix = '') {
  schema.eachPath((name, type) => {
    visit(`${prefix}${name}`, type);
    if (type.schema) eachPath(type.schema, visit, `${prefix}${name}.`);
  });
}

describe('model rules', () => {
  it('no text field carries a number rule (min / max) that is silently ignored', () => {
    const found = [];
    for (const name of mongoose.modelNames()) {
      eachPath(mongoose.model(name).schema, (p, type) => {
        const o = type.options || {};
        const isText = type.instance === 'String';
        if (isText && (o.min !== undefined || o.max !== undefined)) found.push(`${name}.${p}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('no reference defaults to one particular record', () => {
    const found = [];
    for (const name of mongoose.modelNames()) {
      eachPath(mongoose.model(name).schema, (p, type) => {
        const o = type.options || {};
        if (type.instance !== 'ObjectId' || p === '_id' || p.endsWith('._id')) return;
        const d = o.default;
        if (typeof d === 'string' || d instanceof mongoose.Types.ObjectId) found.push(`${name}.${p} = ${d}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('a packing with nobody named is not filed under somebody', () => {
    const Packing = mongoose.model('Packing');
    const p = new Packing({});
    expect(p.checkedBy).toBeUndefined();
    expect(p.packedBy).toBeUndefined();
  });
});
