'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PAPER IS READ WHOLE, OR NOT AT ALL
//
//  The newer paper readers (debit note, TDS challan, Form 16A, price
//  list, power bill, test certificate, cheque, proof of delivery, ID
//  card, goods receipt, notice, enquiry) share one call, utils/docRead.
//  Given more pages than a reader takes, it read the first few and said
//  nothing: five photos of a price list came back as a draft of the first
//  four pages, looking complete. The older readers (bill, payment advice,
//  slip, statement) refuse instead — "At most 4 pages" — and that is the
//  rule here too: say so, and read nothing.
//
//  Found reading utils/docRead.js line by line.
// ══════════════════════════════════════════════════════════════════

const mockCreate = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], usage: {} });
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }), VISION_MODEL: 'test-vision', TEXT_MODEL: 'test-text', isPinned: () => true }));

const { readJson, failure } = require('../../utils/docRead');
const page = (n) => ({ buffer: Buffer.from(`page ${n}`), mimetype: 'image/jpeg' });

beforeEach(() => mockCreate.mockClear());

describe('reading a paper of several pages', () => {
  it('reads every page it is given, up to what the reader takes', async () => {
    const r = await readJson({ pages: [page(1), page(2), page(3)], prompt: 'read', maxPages: 3 });
    expect(r.data).toEqual({ ok: true });
    expect(mockCreate.mock.calls[0][0].messages[0].content.filter((c) => c.type === 'image')).toHaveLength(3);
  });

  it('refuses one page too many, in words, and reads nothing', async () => {
    const err = await readJson({ pages: [page(1), page(2), page(3), page(4)], prompt: 'read', maxPages: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('TOO_MANY_PAGES');
    expect(err.message).toMatch(/At most 3 pages/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(failure(err, 'the price list')).toEqual({ status: 400, message: expect.stringMatching(/At most 3 pages/) });
  });

  it('does not count an empty upload as a page', async () => {
    const r = await readJson({ pages: [page(1), { buffer: Buffer.alloc(0), mimetype: 'image/jpeg' }, null], prompt: 'read', maxPages: 1 });
    expect(r.data).toEqual({ ok: true });
  });
});
