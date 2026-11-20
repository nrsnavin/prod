'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LONG MESSAGE GOES IN PARTS, NOT NOT AT ALL
//
//  Twilio refuses a message body over 1,600 characters (error 21617):
//  nothing is cut, nothing is split — the whole message is rejected. The
//  morning digest on a busy day (five late orders, five stock-outs, five
//  looms due) runs to about 1,800. So the day there was most to say was
//  the day nothing was said. The month-close checklist is longer still.
//
//    • a body over the limit is sent as several messages, broken between
//      lines, in order, each under the limit
//    • nothing is lost and nothing repeated
//    • a picture goes with the first part only
//    • the first part failing is the message failing; a later part
//      failing is said, and the message still counts as having gone
//
//  Found reading utils/whatsapp.js line by line.
// ══════════════════════════════════════════════════════════════════

const mockPost = jest.fn();
jest.mock('axios', () => ({ post: (...a) => mockPost(...a) }));

process.env.WHATSAPP_PROVIDER = 'twilio';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

const { sendWhatsApp, MAX_BODY } = require('../../utils/whatsapp');
const bodies = () => mockPost.mock.calls.map((c) => new URLSearchParams(c[1]).get('Body'));
const medias = () => mockPost.mock.calls.map((c) => new URLSearchParams(c[1]).get('MediaUrl'));

beforeEach(() => { mockPost.mockReset(); mockPost.mockResolvedValue({ data: { sid: 'SM1', status: 'queued' } }); });

describe('a WhatsApp message', () => {
  it('goes as one when it fits', async () => {
    const r = await sendWhatsApp('+919000000001', 'Loom 4 is down');
    expect(r).toMatchObject({ sent: true, providerId: 'SM1' });
    expect(bodies()).toEqual(['Loom 4 is down']);
  });

  it('goes in parts when it is longer than the provider takes — the real digest', async () => {
    const { formatDigest } = require('../../utils/digest.js');
    const seven = (f) => Array.from({ length: 7 }, (_, i) => f(i));
    const text = formatDigest({
      dateLabel: '19 Nov', production: { meters: 184250, shifts: 2 },
      wastage: { meters: 1250, penalty: 4200, entries: 9, topReason: 'Yarn breakage at the creel, repeated on the night shift' },
      stockouts: seven((i) => ({ name: `Polyester 150D Black DTY ${i}`, daysToStockout: 2.4, stock: 1240 })), orderActivity: { edited: 4 },
      commercial: { dispatchValue: 1845200, dispatchDcs: 12, openOrders: 48, toDeliverMeters: 1250000, pendingMeters: 250000, overdueOrders: 6, lowStock: 9 },
      predictedLate: seven((i) => ({ orderNo: 1040 + i, customerName: 'Sri Venkateswara Garments Pvt Ltd', lateWorkingDays: 4 })),
      posteriorDrift: seven((i) => ({ machineLabel: `L-${10 + i}`, elasticName: '25mm Woven Jacquard Black', dropPct: 31 })),
      attendance: { totalEffective: 86, percentOfBaseline: 92, absent: 7, onLeave: 3 }, leave: { pending: 4 }, complaints: { openCount: 3, newYesterday: 1 },
      maintenance: seven((i) => ({ ID: `L-${20 + i}`, overdue: i < 2, daysUntil: i })), repeatOffenders: seven((i) => ({ ID: `L-${30 + i}`, count: 5, openCount: 2 })),
    });
    expect(text.length).toBeGreaterThan(1600);

    const r = await sendWhatsApp('+919000000001', text, { mediaUrl: 'https://files.example/chart.png' });
    expect(r).toMatchObject({ sent: true, parts: 2 });
    const sent = bodies();
    expect(sent).toHaveLength(2);
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(MAX_BODY);
    // Every line of the message, once, in order.
    expect(sent.join('\n').split('\n').filter((l) => l.trim())).toEqual(text.split('\n').filter((l) => l.trim()));
    // No part ends in the middle of a line.
    expect(text.split('\n')).toEqual(expect.arrayContaining(sent[0].split('\n').slice(-1)));
    expect(medias()).toEqual(['https://files.example/chart.png', null]);
  });

  it('breaks one endless line too, rather than send nothing', async () => {
    const r = await sendWhatsApp('+919000000001', 'x'.repeat(4000));
    expect(r).toMatchObject({ sent: true, parts: 3 });
    expect(bodies().join('')).toBe('x'.repeat(4000));
  });

  it('has failed when its first part fails, and says so when a later one does', async () => {
    mockPost.mockRejectedValueOnce({ response: { data: { message: 'Authenticate' } } });
    expect(await sendWhatsApp('+919000000001', 'line\n'.repeat(700))).toMatchObject({ sent: false, error: 'Authenticate' });
    expect(mockPost).toHaveBeenCalledTimes(1);

    mockPost.mockReset();
    mockPost.mockResolvedValueOnce({ data: { sid: 'SM7' } }).mockRejectedValueOnce(new Error('socket hang up'));
    const r = await sendWhatsApp('+919000000001', 'line\n'.repeat(700));
    expect(r).toMatchObject({ sent: true, providerId: 'SM7', partial: true });
    expect(r.error).toMatch(/part 2 of \d+.*socket hang up/);
  });
});
