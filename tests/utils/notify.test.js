'use strict';

const { formatMessage, fmt } = require('../../utils/notify.js');

describe('notify.formatMessage — orderCreated', () => {
  test('includes all provided fields', () => {
    const body = formatMessage('orderCreated', {
      orderNo: 1042,
      po: 'PO-9',
      customerName: 'Acme Corp',
      totalMeters: 12000,
      lineCount: 2,
      supplyDate: '2026-07-01T00:00:00Z',
    });
    expect(body).toMatch(/New order created/);
    expect(body).toMatch(/Order #1042/);
    expect(body).toMatch(/PO: PO-9/);
    expect(body).toMatch(/Acme Corp/);
    expect(body).toMatch(/12,000 m/);   // en-IN grouping
    expect(body).toMatch(/Items: 2/);
  });

  test('omits missing fields without leaving blank lines', () => {
    const body = formatMessage('orderCreated', { orderNo: 7 });
    expect(body).toMatch(/Order #7/);
    expect(body).not.toMatch(/PO:/);
    expect(body).not.toMatch(/Customer:/);
    // No double newlines from skipped fields.
    expect(body).not.toMatch(/\n\n/);
  });
});

describe('notify.formatMessage — orderApproved', () => {
  test('includes by/via/customer/qty/supply', () => {
    const body = formatMessage('orderApproved', {
      orderNo: 1042, customerName: 'Acme', totalMeters: 12000,
      by: 'Navin', via: 'WhatsApp (+91…)',
      supplyDate: '2026-07-15',
    });
    expect(body).toMatch(/Order approved/);
    expect(body).toMatch(/Order #1042/);
    expect(body).toMatch(/Acme/);
    expect(body).toMatch(/12,000 m/);
    expect(body).toMatch(/By: Navin/);
    expect(body).toMatch(/Via: WhatsApp/);
  });
});

describe('notify.formatMessage — orderCancelled', () => {
  test('renders status transition + reason + actor + counts', () => {
    const body = formatMessage('orderCancelled', {
      orderNo: 1042,
      customerName: 'Acme',
      previousStatus: 'Approved',
      releasedReservations: 2,
      refundedMaterials: 5,
      reason: 'Customer changed mind',
      by: 'Navin',
      via: 'WhatsApp (+91...)',
    });
    expect(body).toMatch(/Order cancelled/);
    expect(body).toMatch(/Order #1042/);
    expect(body).toMatch(/Previous status: Approved/);
    expect(body).toMatch(/Reservations released: 2/);
    expect(body).toMatch(/Materials refunded: 5/);
    expect(body).toMatch(/Reason: Customer changed mind/);
    expect(body).toMatch(/By: Navin/);
    expect(body).toMatch(/Via: WhatsApp/);
  });

  test('omits absent fields cleanly', () => {
    const body = formatMessage('orderCancelled', { orderNo: 7 });
    expect(body).toMatch(/Order #7/);
    expect(body).not.toMatch(/Reason:/);
    expect(body).not.toMatch(/By:/);
  });
});

describe('notify.formatMessage — orderForceApproved', () => {
  test('surfaces the override reason and actor', () => {
    const body = formatMessage('orderForceApproved', {
      orderNo: 5, customerName: 'Beta', by: 'Admin', reason: 'Urgent rush',
    });
    expect(body).toMatch(/force-approved/i);
    expect(body).toMatch(/guardrail override/i);
    expect(body).toMatch(/Urgent rush/);
    expect(body).toMatch(/By: Admin/);
  });
});

describe('notify.formatMessage — orderPredictedLate', () => {
  test('shows predicted vs promised + lateness', () => {
    const body = formatMessage('orderPredictedLate', {
      orderNo: 9,
      expectedDate: '2026-07-05',
      supplyDate:   '2026-07-01',
      lateWorkingDays: 3,
    });
    expect(body).toMatch(/predicted late/i);
    expect(body).toMatch(/Late by: 3 working day/);
  });
});

describe('notify.formatMessage — unknown event', () => {
  test('returns null so the orchestrator can skip it', () => {
    expect(formatMessage('does_not_exist', {})).toBeNull();
  });
});

describe('notify.fmt.test', () => {
  test('uses a default body when none provided', () => {
    expect(fmt.test({})).toMatch(/Test message/i);
  });
  test('uses the supplied body when provided', () => {
    expect(fmt.test({ body: 'hi there' })).toBe('hi there');
  });
});
