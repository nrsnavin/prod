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

describe('notify.formatMessage — anomalyDetected', () => {
  test('shows machine, shift, produced vs avg, percent', () => {
    const body = formatMessage('anomalyDetected', {
      machineId: 'M3', shift: 'DAY', date: '2026-06-20',
      produced: 100, average: 400, percent: 25,
    });
    expect(body).toMatch(/Production anomaly/);
    expect(body).toMatch(/Machine: M3/);
    expect(body).toMatch(/Machine's recent avg: 400 m/);
    expect(body).toMatch(/25% of normal/);
  });
});

describe('notify.formatMessage — machineBreakdown', () => {
  test('renders machine id + previous status + order', () => {
    const body = formatMessage('machineBreakdown', {
      machineId: 'M3', previousStatus: 'running',
      orderRunning: 'job123', by: 'Navin', via: 'Admin app',
    });
    expect(body).toMatch(/Machine breakdown/);
    expect(body).toMatch(/Machine: M3/);
    expect(body).toMatch(/Was: running/);
    expect(body).toMatch(/Reported by: Navin/);
  });
});

describe('notify.formatMessage — shiftBelowThreshold', () => {
  test('shows produced vs baseline + percent', () => {
    const body = formatMessage('shiftBelowThreshold', {
      machineId: 'M3', shift: 'DAY', date: '2026-06-20',
      produced: 200, baseline: 500, percentOfBaseline: 40,
    });
    expect(body).toMatch(/Low-output shift/);
    expect(body).toMatch(/Produced: 200 m/);
    expect(body).toMatch(/Plant baseline: 500 m/);
    expect(body).toMatch(/40% of baseline/);
  });
});

describe('notify.formatMessage — wastageHighEvent', () => {
  test('renders job, elastic, quantity, percent', () => {
    const body = formatMessage('wastageHighEvent', {
      jobNo: 42, elasticName: 'Elastic-A',
      quantity: 50, dailyProduction: 400, percent: 12.5,
      reason: 'Yarn break', employee: 'Ravi',
    });
    expect(body).toMatch(/High wastage event/);
    expect(body).toMatch(/Job: #42/);
    expect(body).toMatch(/Elastic: Elastic-A/);
    expect(body).toMatch(/13% — above 10% threshold/);
    expect(body).toMatch(/Yarn break/);
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

describe('notify.formatMessage — criticalStockout', () => {
  test('shows material, stock vs floor, pending order count', () => {
    const body = formatMessage('criticalStockout', {
      materialName: 'Yarn-20s', category: 'Yarn',
      stock: 4, minStock: 10, pendingOrders: 3,
      reason: 'Order #1042 approval',
    });
    expect(body).toMatch(/Critical stockout/);
    expect(body).toMatch(/Yarn-20s/);
    expect(body).toMatch(/Min floor: 10/);
    expect(body).toMatch(/Pending orders needing it: 3/);
    expect(body).toMatch(/No open PO in flight/);
  });
});

describe('notify.formatMessage — priceChangeAbove10', () => {
  test('renders direction arrow + percent + old/new', () => {
    const up = formatMessage('priceChangeAbove10', {
      materialName: 'Latex', oldPrice: 100, newPrice: 125,
      percent: 25, direction: 'up', recentConsumption: 4200,
    });
    expect(up).toMatch(/↑ 25%/);
    expect(up).toMatch(/Was: ₹100/);
    expect(up).toMatch(/Now: ₹125/);
    expect(up).toMatch(/30d usage: 4,200/);
    const down = formatMessage('priceChangeAbove10', {
      materialName: 'Latex', oldPrice: 100, newPrice: 80,
      percent: -20, direction: 'down',
    });
    expect(down).toMatch(/↓ 20%/);
  });
});

describe('notify.formatMessage — poReceivedForCritical', () => {
  test('shows quantity, before/after vs floor, supplier', () => {
    const body = formatMessage('poReceivedForCritical', {
      materialName: 'Yarn-20s', quantity: 50, stockBefore: 4,
      stockAfter: 54, minStock: 10, supplierName: 'Acme Yarns',
    });
    expect(body).toMatch(/PO received/);
    expect(body).toMatch(/Inwarded: 50/);
    expect(body).toMatch(/Was: 4/);
    expect(body).toMatch(/Now: 54/);
    expect(body).toMatch(/Acme Yarns/);
  });
});

describe('notify.formatMessage — customerComplaintFiled', () => {
  test('shows subject, category, employee name, body preview', () => {
    const body = formatMessage('customerComplaintFiled', {
      subject: 'Loom #3 unsafe', category: 'safety',
      employeeName: 'Ravi', bodyPreview: 'The guard rail is missing on M3.',
    });
    expect(body).toMatch(/Employee complaint filed/);
    expect(body).toMatch(/Subject: Loom #3 unsafe/);
    expect(body).toMatch(/Category: safety/);
    expect(body).toMatch(/From: Ravi/);
    expect(body).toMatch(/guard rail/);
  });
  test('shows anonymous when flagged', () => {
    const body = formatMessage('customerComplaintFiled', {
      subject: 'x', isAnonymous: true,
    });
    expect(body).toMatch(/From: \(anonymous\)/);
  });
});

describe('notify.formatMessage — attendanceCrashedToday', () => {
  test('renders shift, present vs baseline, percent', () => {
    const body = formatMessage('attendanceCrashedToday', {
      dateLabel: '20 Jun 2026', shift: 'DAY',
      present: 8, baseline: 22, percentOfBaseline: 36,
    });
    expect(body).toMatch(/Attendance crashed today/);
    expect(body).toMatch(/Shift: DAY/);
    expect(body).toMatch(/Effective present: 8/);
    expect(body).toMatch(/30d baseline: 22/);
    expect(body).toMatch(/36% of baseline/);
  });
});

describe('notify.formatMessage — dcDelayedDelivery', () => {
  test('renders DC#, order, promised vs dispatched, late by N days', () => {
    const body = formatMessage('dcDelayedDelivery', {
      dcNumber: 'DC/E/26-27/001', orderNo: 1042, customerName: 'Acme',
      supplyDate: '2026-06-15', dispatchDate: '2026-06-20', lateDays: 5,
    });
    expect(body).toMatch(/DC dispatched — late vs promise/);
    expect(body).toMatch(/DC: DC\/E\/26-27\/001/);
    expect(body).toMatch(/Order #1042/);
    expect(body).toMatch(/Late by: 5 day/);
  });
});

describe('notify.formatMessage — system health', () => {
  test('notificationDeliveryFailed shows error count, ratio, top reason', () => {
    const body = formatMessage('notificationDeliveryFailed', {
      windowLabel: 'last 24h', errorCount: 8, totalAttempts: 20,
      topReason: 'Twilio: 21610',
    });
    expect(body).toMatch(/Notification delivery failing/);
    expect(body).toMatch(/Errors: 8/);
    expect(body).toMatch(/Attempts: 20/);
    expect(body).toMatch(/Twilio: 21610/);
  });

  test('cronDigestSkipped shows last-sent timestamp', () => {
    const body = formatMessage('cronDigestSkipped', {
      lastSentLabel: '19/06/2026, 09:01',
    });
    expect(body).toMatch(/Morning digest didn't run/);
    expect(body).toMatch(/19\/06\/2026/);
  });

  test('cronDigestSkipped falls back to a generic message when no last seen', () => {
    const body = formatMessage('cronDigestSkipped', {});
    expect(body).toMatch(/No digest seen in 25h/);
  });

  test('notifyDryRunStillActive shows dry-run count + how to fix', () => {
    const body = formatMessage('notifyDryRunStillActive', {
      windowLabel: 'last 24h', dryRunCount: 12,
    });
    expect(body).toMatch(/dry-run mode/);
    expect(body).toMatch(/Dry-run pings: 12/);
    expect(body).toMatch(/TWILIO_ACCOUNT_SID/);
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
