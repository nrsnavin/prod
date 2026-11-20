'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SHIFT SHEET'S READER KNOWS THE SHEET IT READS
//
//  The printed shift sheet gained a Sign box between Timer and Remarks
//  (utils/shiftSheetPdf.js). The reader of the scanned sheet went on
//  being told there were three hand-written columns, Production, Timer
//  and Remarks — so a supervisor's initials were the next thing written
//  after the timer, where it had been told the remark would be.
//
//  Held here: every hand-written column the sheet prints is named to
//  the reader, initials are never a remark, and the prompt's version
//  moved with its wording (utils/aiPrompts.js).
// ══════════════════════════════════════════════════════════════════

let mockReply = { content: [{ type: 'text', text: '{"rows":[]}' }], usage: {}, stop_reason: 'end_turn' };
const mockCreate = jest.fn(async () => mockReply);
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }), VISION_MODEL: 'test-vision', TEXT_MODEL: 'test-text', isPinned: () => true }));

const { extractShiftRows } = require('../../utils/shiftSheetOcr');
const { buildShiftSheetPdf } = require('../../utils/shiftSheetPdf');
const { promptVersion } = require('../../utils/aiPrompts');
const { pdfText } = require('../helpers/pdfText');

const sheet = () => buildShiftSheetPdf({
  dateLabel: '20 Nov 2026', shift: 'DAY', planNo: 'SP-1',
  rows: [{ sdId: '665f1c2e9a7b4c0012ab3f4d', machine: 'L-7', operator: 'Ravi', job: 'J-12' }],
});

const promptSent = async () => {
  mockCreate.mockClear();
  await extractShiftRows(await sheet());
  const content = mockCreate.mock.calls[0][0].messages[0].content;
  return content.find((b) => b.type === 'text').text;
};

describe('the shift sheet and its reader', () => {
  it('the sheet prints four columns to write in', async () => {
    const text = (await pdfText(await sheet())).toUpperCase();
    for (const head of ['PRODUCTION (M)', 'TIMER (H:M:S)', 'SIGN', 'REMARKS']) expect(text).toContain(head);
  });

  it('the reader is told of each of them, and that initials are not a remark', async () => {
    const prompt = await promptSent();
    for (const head of ['"Production (m)"', '"Timer (H:M:S)"', '"Sign"', '"Remarks"']) expect(prompt).toContain(head);
    expect(prompt).not.toMatch(/three\s+HAND-WRITTEN/i);
    expect(prompt).toMatch(/initials[^.]*never[^.]*remark/i);
  });

  it('its version moved with its wording', () => {
    expect(promptVersion('shift-sheet-ocr')).not.toBe('v1.0');
  });

  it('a row is still read as it was', async () => {
    mockReply = { content: [{ type: 'text', text: '{"rows":[{"code":"sd-ab3f4d","production":"1,240","timer":"7:45:00","remarks":" warp break ","confidence":0.9}]}' }], usage: {}, stop_reason: 'end_turn' };
    const out = await extractShiftRows(await sheet());
    expect(out.rows).toEqual([{ code: 'SD-AB3F4D', production: 1240, timer: '7:45:00', remarks: 'warp break', confidence: 0.9 }]);
  });
});
