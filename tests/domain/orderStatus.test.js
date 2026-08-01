'use strict';
//
// The rule that stops an order coming back from the dead.
//
// Order.status was written from nine places with no shared rule, three
// of them reacting to something happening to a JOB. Cancelling the last
// job on a cancelled order set it to Approved; completing the last job
// on a deleted one set it to Completed.

const {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  canTransition,
  isTerminal,
  applyOrderStatus,
} = require('../../domain/orderStatus');

describe('canTransition', () => {
  test('allows the ordinary forward moves', () => {
    expect(canTransition('Open', 'Approved')).toBe(true);
    expect(canTransition('Approved', 'InProgress')).toBe(true);
    expect(canTransition('InProgress', 'Completed')).toBe(true);
  });

  test('allows the rollback when the last job is cancelled', () => {
    // Nothing is planned any more, so a running order goes back to
    // waiting rather than pretending work is under way.
    expect(canTransition('InProgress', 'Approved')).toBe(true);
  });

  test('lets an approved order complete without an explicit start', () => {
    expect(canTransition('Approved', 'Completed')).toBe(true);
  });

  test('refuses to reopen anything finished', () => {
    for (const from of ['Completed', 'Cancelled', 'Deleted']) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test('refuses to skip approval', () => {
    // Approval is where raw material is debited; an order that reaches
    // the floor without it has consumed material nobody deducted.
    expect(canTransition('Open', 'InProgress')).toBe(false);
    expect(canTransition('Open', 'Completed')).toBe(false);
  });

  test('a move to the status it already has is not a move', () => {
    for (const s of ORDER_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  test('an unknown status goes nowhere', () => {
    expect(canTransition('nonsense', 'Approved')).toBe(false);
    expect(canTransition('Open', 'nonsense')).toBe(false);
  });
});

describe('isTerminal', () => {
  test('marks the three end states and nothing else', () => {
    expect(isTerminal('Completed')).toBe(true);
    expect(isTerminal('Cancelled')).toBe(true);
    expect(isTerminal('Deleted')).toBe(true);
    expect(isTerminal('Open')).toBe(false);
    expect(isTerminal('Approved')).toBe(false);
    expect(isTerminal('InProgress')).toBe(false);
  });
});

describe('applyOrderStatus', () => {
  test('moves the order and dates the move', () => {
    const order = { status: 'Approved' };
    expect(applyOrderStatus(order, 'InProgress', 'u1')).toBe(true);
    expect(order.status).toBe('InProgress');
    expect(order.startedBy).toBe('u1');
    expect(order.startedAt).toBeInstanceOf(Date);
  });

  test('stamps every status that has a stamp', () => {
    // Setting Completed without completedAt leaves a record nobody can
    // date, which is how a timeline ends up with holes.
    const done = { status: 'InProgress' };
    applyOrderStatus(done, 'Completed', 'u1');
    expect(done.completedAt).toBeInstanceOf(Date);

    const gone = { status: 'InProgress' };
    applyOrderStatus(gone, 'Cancelled', 'u1');
    expect(gone.cancelledAt).toBeInstanceOf(Date);
  });

  test('leaves the order untouched when the move is not allowed', () => {
    const order = { status: 'Cancelled' };
    expect(applyOrderStatus(order, 'Approved', 'u1')).toBe(false);
    expect(order.status).toBe('Cancelled');
    expect(order.approvedAt).toBeUndefined();
  });

  test('reports whether it applied, so a caller can skip its fingerprint', () => {
    // A cascade that stamps ORDER_COMPLETED without having completed
    // anything writes a milestone that did not happen.
    expect(applyOrderStatus({ status: 'Deleted' }, 'Completed')).toBe(false);
    expect(applyOrderStatus({ status: 'InProgress' }, 'Completed')).toBe(true);
  });

  test('defaults the actor to null rather than undefined', () => {
    const order = { status: 'Approved' };
    applyOrderStatus(order, 'InProgress');
    expect(order.startedBy).toBeNull();
  });

  test('survives a missing order', () => {
    expect(applyOrderStatus(null, 'Completed')).toBe(false);
    expect(applyOrderStatus(undefined, 'Completed')).toBe(false);
  });
});

describe('the table itself', () => {
  test('every status named in it is a real one', () => {
    for (const [from, tos] of Object.entries(ORDER_TRANSITIONS)) {
      expect(ORDER_STATUSES).toContain(from);
      for (const to of tos) expect(ORDER_STATUSES).toContain(to);
    }
  });

  test('covers every status, so none is silently unreachable', () => {
    for (const s of ORDER_STATUSES) {
      expect(Object.keys(ORDER_TRANSITIONS)).toContain(s);
    }
  });

  test('is frozen — the rule is not edited at runtime', () => {
    expect(Object.isFrozen(ORDER_TRANSITIONS)).toBe(true);
    for (const tos of Object.values(ORDER_TRANSITIONS)) {
      expect(Object.isFrozen(tos)).toBe(true);
    }
  });
});

// ── The rule has to stay the only writer ──────────────────────────────
// The bugs it fixes were not wrong logic; they were writes that never
// consulted a rule. A new `order.status = '...'` in the job router
// would reintroduce exactly that, so the source is checked directly.
// The order router owns the deliberate, user-driven transitions and is
// not covered here — only the cascades, which react to something else.
describe('the job router does not set an order status by hand', () => {
  const fs = require('fs');
  const path = require('path');

  test('every order status change there goes through applyOrderStatus', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'api', 'job.js'),
      'utf8'
    );
    const direct = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      // `=` but not `==`: a comparison is exactly what these writes
      // should have been doing, so it must not be flagged as one.
      .filter(({ line }) => /^order\.status\s*=(?!=)/.test(line));

    expect(direct.map((d) => `${d.no}: ${d.line}`)).toEqual([]);
  });
});
