'use strict';
// What the slip reader does with the model's reply: cleans every value,
// batches photos, and never trusts a date it cannot parse.

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  VISION_MODEL: 'test-vision',
}));

const { readSlip, _internals } = require('../../utils/slipOcr');
const { normaliseRow, asTimer, asDate } = _internals;

const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 5 } });
const jpeg = { buffer: Buffer.from('x'), mimetype: 'image/jpeg' };

afterEach(() => mockCreate.mockReset());

describe('cleaning a row', () => {
  it('keeps what was written and drops what is not a number', () => {
    expect(normaliseRow({ machine: ' M-07 ', production: '1,240', timer: '7:5', confidence: 2 }))
      .toMatchObject({ machine: 'M-07', production: 1240, timer: '7:05:00', confidence: 1 });
    expect(normaliseRow({ code: 'sd-8f3a2c', production: 'abc' })).toMatchObject({ code: 'SD-8F3A2C', production: null });
    expect(normaliseRow({ production: 100 })).toBeNull(); // nothing to match it by
  });

  it('accepts only real times and dates', () => {
    expect(asTimer('07:45:12')).toBe('7:45:12');
    expect(asTimer('1234.5')).toBeNull();
    expect(asDate('2026-02-30')).toBeNull();
    expect(asDate('2026-10-06')).toBe('2026-10-06');
  });
});

describe('reading', () => {
  it('sends photos as images, four to a call, and merges the answers', async () => {
    mockCreate
      .mockResolvedValueOnce(reply({ format: 'slip', date: null, shift: 'DAY', rows: [{ machine: '1', production: 10 }] }))
      .mockResolvedValueOnce(reply({ format: 'slip', date: '2026-10-06', rows: [{ machine: '2', production: 20 }] }));
    const out = await readSlip([jpeg, jpeg, jpeg, jpeg, jpeg]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const firstCall = mockCreate.mock.calls[0][0].messages[0].content;
    expect(firstCall.filter((c) => c.type === 'image')).toHaveLength(4);
    expect(out).toMatchObject({ format: 'slip', date: '2026-10-06', shift: 'DAY', problem: null });
    expect(out.rows.map((r) => r.machine)).toEqual(['1', '2']);
    expect(out.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  });

  it('a PDF goes as a document; the plan number is tidied', async () => {
    mockCreate.mockResolvedValueOnce(reply({ format: 'sheet', planNo: 'sp20261006d', rows: [{ code: 'SD-AAAAAA', production: 5 }] }));
    const out = await readSlip([{ buffer: Buffer.from('%PDF'), mimetype: 'application/pdf' }]);
    expect(mockCreate.mock.calls[0][0].messages[0].content[0].type).toBe('document');
    expect(out.planNo).toBe('SP-20261006-D');
  });

  it('a floor sheet: its sheet number names the shift; each row keeps the printed job and the signature', async () => {
    mockCreate.mockResolvedValueOnce(reply({
      format: 'floor', planNo: null, sheetNo: 'fs 20261021 n',
      rows: [
        { machine: 'M-2', job: 'j-12', operator: 'Ravi', production: '900', timer: '6:00', signed: true },
        { machine: 'M-3', job: 'free' },
      ],
    }));
    const out = await readSlip([jpeg]);
    expect(out).toMatchObject({ format: 'floor', sheetNo: 'FS-20261021-N', planNo: null });
    expect(out.rows[0]).toMatchObject({ machine: 'M-2', job: 'J-12', operator: 'Ravi', production: 900, timer: '6:00:00', signed: true });
    expect(out.rows[1]).toMatchObject({ job: 'FREE', operator: null, production: null, signed: false });
    expect(mockCreate.mock.calls[0][0].messages[0].content.slice(-1)[0].text).toMatch(/Floor Production Sheet/);
  });

  it('nothing read says why', async () => {
    mockCreate.mockResolvedValueOnce(reply({ rows: [], problem: 'not_a_slip' }));
    expect((await readSlip([jpeg])).problem).toBe('not_a_slip');
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'sorry' }] });
    expect((await readSlip([jpeg])).problem).toBe('unreadable');
  });

  it('refuses what it cannot read before calling anything', async () => {
    await expect(readSlip([{ buffer: Buffer.from('x'), mimetype: 'video/mp4' }])).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    await expect(readSlip(Array(11).fill(jpeg))).rejects.toMatchObject({ code: 'TOO_MANY_PAGES' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
