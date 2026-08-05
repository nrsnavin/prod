'use strict';
// Ask Jarvis answers with the CALLER's permissions.
//
// The assistant is an always-on feature every account holds, and its
// tools query Orders / RawMaterials / Machines / Wastage directly. Before
// this, a user whose admin had removed /orders could still read every
// at-risk order simply by asking for it — a plain-language bypass of the
// REST feature gate. These tests pin the tool scoping itself, without
// calling the model.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const { allowedToolNames, TOOL_FEATURES } = require('../../api/assistant.js');

describe('assistant tool scoping', () => {
  test('every tool declares the feature that owns its data', () => {
    for (const [tool, keys] of Object.entries(TOOL_FEATURES)) {
      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBeGreaterThan(0);
    }
  });

  test('a narrowed feature list only exposes that module\'s tools', () => {
    const allowed = allowedToolNames({ features: ['/orders'] });
    expect(allowed).toEqual(expect.arrayContaining(['get_orders_at_risk', 'find_order']));
    expect(allowed).not.toContain('get_materials_to_reorder');
    expect(allowed).not.toContain('find_material');
    expect(allowed).not.toContain('get_machine_status');
    expect(allowed).not.toContain('get_wastage_summary');
  });

  test('a list with no data features exposes no tools at all', () => {
    expect(allowedToolNames({ features: ['/jobs'] })).toEqual([]);
  });

  test('an account with no explicit list keeps every tool (defers to the role gate)', () => {
    expect(allowedToolNames({ features: [] }).sort())
      .toEqual(Object.keys(TOOL_FEATURES).sort());
    expect(allowedToolNames({}).sort())
      .toEqual(Object.keys(TOOL_FEATURES).sort());
  });

  test('multiple features union their tools', () => {
    const allowed = allowedToolNames({ features: ['/materials', '/machines'] });
    expect(allowed).toEqual(expect.arrayContaining([
      'get_materials_to_reorder', 'find_material', 'get_machine_status',
    ]));
    expect(allowed).not.toContain('find_order');
  });
});
