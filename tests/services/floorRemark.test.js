'use strict';
// ══════════════════════════════════════════════════════════════════
//  A FLOOR REMARK, CLASSED — services/floorRemark.js
//
//  Keywords answer at once; the model, when set up, refines within a few
//  seconds; a slow or broken answer leaves the keywords standing.
// ══════════════════════════════════════════════════════════════════

const mockCreate = jest.fn();
let mockClaude = null;
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => mockClaude,
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));
jest.mock('../../services/aiLedger', () => ({ record: jest.fn(async () => null), settle: jest.fn(async () => null) }));

process.env.FLOOR_REMARK_AI_MS = '50';
const { classify, keywordClass, minutesIn } = require('../../services/floorRemark');

beforeEach(() => { mockCreate.mockReset(); mockClaude = null; });

describe('by keywords', () => {
  it.each([
    ['beam change 40 min', 'beam_change', 40, false],
    ['motor sound, head 3 stopped 1 hr 20 min', 'mechanical', 80, true],
    ['spark from the panel', 'electrical', null, true],
    ['power cut 2 hours', 'power_cut', 120, false],
    ['கரண்ட் இல்ல 30 நிமிடம்', 'power_cut', 30, false],
    ['waiting for beam', 'waiting_material', null, false],
    ['rubber breaking often', 'yarn_break', null, false],
    ['operator absent', 'no_operator', null, false],
    ['width variation on head 2', 'quality', null, false],
    ['all fine', 'other', null, false],
  ])('%s → %s', (text, kind, minutes, fault) => {
    expect(keywordClass(text)).toMatchObject({ kind, minutes, machineFault: fault, ai: false });
  });

  it('reads minutes and hours, but not metres or heads', () => {
    expect(minutesIn('300 m made, 40 min beam')).toBe(40);
    expect(minutesIn('5 heads running')).toBeNull();
    expect(minutesIn('1.5 hrs')).toBe(90);
  });
});

describe('with the model', () => {
  it('takes its class, keeping a spark the fitter\'s whatever it says', async () => {
    mockClaude = { messages: { create: mockCreate } };
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"kind":"mechanical","minutes":25,"machineFault":true,"summary":"Take-up roller slipping","confidence":0.8}' }] });
    expect(await classify('take up slipping 25 min')).toMatchObject({ kind: 'mechanical', minutes: 25, machineFault: true, summary: 'Take-up roller slipping', ai: true });

    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"kind":"other","minutes":null,"machineFault":false}' }] });
    expect(await classify('small spark near motor')).toMatchObject({ kind: 'other', machineFault: true });
  });

  it('a slow, broken or unknown answer leaves the keywords standing', async () => {
    mockClaude = { messages: { create: mockCreate } };
    mockCreate.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ content: [{ type: 'text', text: '{"kind":"quality"}' }] }), 500)));
    expect(await classify('beam change 40 min')).toMatchObject({ kind: 'beam_change', minutes: 40, ai: false });
    mockCreate.mockRejectedValueOnce(new Error('down'));
    expect(await classify('beam change')).toMatchObject({ kind: 'beam_change', ai: false });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"kind":"lunch"}' }] });
    expect(await classify('beam change')).toMatchObject({ kind: 'beam_change', ai: false });
    expect(await classify('   ')).toBeNull();
  });
});
