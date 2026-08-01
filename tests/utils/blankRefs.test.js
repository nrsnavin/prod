'use strict';
//
// Empty strings where a reference belongs.
//
// A form's unpicked <select> submits "". On a field the schema declares
// as an ObjectId that is a cast error, and Mongoose rejects the whole
// document for it — a warping plan was refused outright because the dye
// lot, the one field meant to be optional, had not been chosen.
//
// These tests pin both halves: that the blank becomes null, and that
// ordinary text is left alone. The second matters more — over-reaching
// here would corrupt real values, which is worse than the crash.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  blankRefsToNull,
  refFieldNames,
  ambiguousRefNames,
  _resetCache,
} = require('../../utils/blankRefs');

// The names are derived from the registered schemas, so the models have
// to be loaded for the scan to see anything.
beforeAll(() => {
  const dir = path.join(__dirname, '..', '..', 'models');
  for (const f of fs.readdirSync(dir)) {
    if (/\.(js|cjs)$/.test(f)) {
      try { require(path.join(dir, f)); } catch { /* a model that needs more than a require */ }
    }
  }
  _resetCache();
});

describe('which names count as a reference', () => {
  test('finds the references a form can actually leave blank', () => {
    const names = refFieldNames();
    for (const n of ['yarnLot', 'warpYarn', 'supplier', 'machine', 'employee', 'rawMaterial', 'job', 'order', 'elastic']) {
      expect(names.has(n)).toBe(true);
    }
  });

  test('refuses a name that is text somewhere else', () => {
    const names = refFieldNames();
    // `status` is an ObjectId on Elastic and a String on 27 other
    // models; blanking it would wipe ordinary statuses.
    expect(names.has('status')).toBe(false);
    expect(names.has('customer')).toBe(false);
    expect(names.has('_id')).toBe(false);
  });

  test('reports what it skipped, so the exclusion is visible', () => {
    // Folklore is how a rule like this rots. If a schema changes, this
    // list changes with it and can be read.
    expect(ambiguousRefNames()).toEqual(expect.arrayContaining(['status', 'customer']));
  });
});

describe('blanking a reference', () => {
  const names = () => refFieldNames();

  test('turns an empty reference into null', () => {
    const body = { yarnLot: '', warpYarn: 'abc' };
    blankRefsToNull(body, names());
    expect(body).toEqual({ yarnLot: null, warpYarn: 'abc' });
  });

  test('reaches into nested objects and arrays', () => {
    const body = {
      beams: [
        { sections: [{ warpYarn: 'y1', yarnLot: '' }, { warpYarn: '', yarnLot: '' }] },
        { sections: [{ warpYarn: 'y2', yarnLot: 'l1' }] },
      ],
    };
    blankRefsToNull(body, names());
    expect(body.beams[0].sections[0].yarnLot).toBeNull();
    expect(body.beams[0].sections[1].warpYarn).toBeNull();
    expect(body.beams[1].sections[0].yarnLot).toBe('l1');
  });

  test('leaves ordinary text alone, however empty', () => {
    const body = { remarks: '', notes: '', name: '', reason: '', description: '' };
    blankRefsToNull(body, names());
    expect(body).toEqual({ remarks: '', notes: '', name: '', reason: '', description: '' });
  });

  test('leaves an ambiguous name alone even when blank', () => {
    // Wiping a status because one model happens to use the name for a
    // reference is exactly the over-reach this must not commit.
    const body = { status: '', customer: '' };
    blankRefsToNull(body, names());
    expect(body).toEqual({ status: '', customer: '' });
  });

  test('touches only the empty string, not whitespace', () => {
    // A space is something someone typed; turning it into null guesses.
    const body = { yarnLot: '   ' };
    blankRefsToNull(body, names());
    expect(body.yarnLot).toBe('   ');
  });

  test('leaves other falsy values as they are', () => {
    const body = { yarnLot: null, machine: undefined, supplier: 0, employee: false };
    blankRefsToNull(body, names());
    expect(body.yarnLot).toBeNull();
    expect(body.machine).toBeUndefined();
    expect(body.supplier).toBe(0);
    expect(body.employee).toBe(false);
  });

  test('survives a body that is not an object', () => {
    expect(blankRefsToNull(null, names())).toBeNull();
    expect(blankRefsToNull('x', names())).toBe('x');
    expect(blankRefsToNull(7, names())).toBe(7);
  });

  test('stops before a pathological nesting exhausts the stack', () => {
    let deep = { yarnLot: '' };
    for (let i = 0; i < 200; i++) deep = { nested: deep };
    expect(() => blankRefsToNull(deep, names())).not.toThrow();
  });

  test('does not walk a prototype-polluting key', () => {
    const body = JSON.parse('{"__proto__": {"yarnLot": ""}, "yarnLot": ""}');
    blankRefsToNull(body, names());
    expect(body.yarnLot).toBeNull();
    expect({}.yarnLot).toBeUndefined();
  });
});
