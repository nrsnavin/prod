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
    const allowed = allowedToolNames({ role: 'accounts', features: ['/orders'] });
    expect(allowed).toEqual(expect.arrayContaining(['get_orders_at_risk', 'find_order']));
    expect(allowed).not.toContain('get_materials_to_reorder');
    expect(allowed).not.toContain('find_material');
    expect(allowed).not.toContain('get_machine_status');
    expect(allowed).not.toContain('get_wastage_summary');
  });

  test('a list with no data features exposes no tools at all', () => {
    expect(allowedToolNames({ role: 'production', features: ['/jobs'] })).toEqual([]);
  });

  // Jarvis must read absent-vs-empty exactly as requireFeature does, or it
  // becomes the way around it: an admin who granted nothing could still
  // ask for the data in words.
  test('an explicitly empty list exposes no tools', () => {
    expect(allowedToolNames({ role: 'admin', features: [] })).toEqual([]);
  });

  // "Defers to the role gate" — and the assistant's route has none: it is
  // open to every login. So the role gate each module's own routes sit
  // behind (app.js) is applied here, tool by tool. Without it an account
  // with no list kept EVERY tool: a production login, shut out of
  // /accounts by its role, could ask for the bank balances.
  test('an account with NO list keeps the tools its ROLE may open', () => {
    expect(allowedToolNames({ role: 'admin' }).sort()).toEqual(Object.keys(TOOL_FEATURES).sort());
    expect(allowedToolNames({ role: 'admin', features: undefined }).sort()).toEqual(Object.keys(TOOL_FEATURES).sort());
    const floor = allowedToolNames({ role: 'production' });
    expect(floor.sort()).toEqual(['find_material', 'get_machine_status', 'get_materials_to_reorder', 'get_wastage_summary', 'run_report']);
    const books = allowedToolNames({ role: 'accounts' });
    expect(books).toEqual(expect.arrayContaining(['get_receivables', 'get_cash_position', 'get_party_statement', 'find_order', 'find_material', 'run_report']));
    expect(books).not.toContain('get_machine_status');
    expect(books).not.toContain('get_wastage_summary');
  });

  test('a role that opens none of the modules, or no role at all, gets no tools', () => {
    expect(allowedToolNames({ role: 'marketing' })).toEqual([]);
    expect(allowedToolNames({ role: 'sales' })).toEqual([]);
    expect(allowedToolNames({})).toEqual([]);
    expect(allowedToolNames(undefined)).toEqual([]);
  });

  test('every tool names the roles its module is open to', () => {
    const { TOOL_ROLES } = require('../../api/assistant.js');
    expect(Object.keys(TOOL_ROLES).sort()).toEqual(Object.keys(TOOL_FEATURES).sort());
    for (const roles of Object.values(TOOL_ROLES)) expect(roles.length).toBeGreaterThan(0);
  });

  test('multiple features union their tools', () => {
    const allowed = allowedToolNames({ role: 'admin', features: ['/materials', '/machines'] });
    expect(allowed).toEqual(expect.arrayContaining([
      'get_materials_to_reorder', 'find_material', 'get_machine_status',
    ]));
    expect(allowed).not.toContain('find_order');
  });
});
