// transition-order.test.ts
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { Money, InvalidMoney } from './money';
import { ALL_STATES, ALLOWED_TRANSITIONS, TERMINAL_STATES, isAllowed } from './order-states';
import {
  Order,
  OrderStore,
  transitionOrder,
  IllegalTransition,
  StaleState,
  OrderNotFound,
} from './transition-order';

// In-memory store. It COPIES on read and write so a function that secretly mutates
// the order it loaded cannot change "stored" data by accident, which keeps tests honest.
class InMemoryOrderStore implements OrderStore {
  private orders = new Map<string, Order>();
  saveCalls = 0;
  constructor(...initial: Order[]) {
    initial.forEach((o) => this.orders.set(o.id, structuredClone(o)));
  }
  async get(id: string) {
    const o = this.orders.get(id);
    return o ? structuredClone(o) : null;
  }
  async save(order: Order) {
    this.saveCalls++;
    this.orders.set(order.id, structuredClone(order));
  }
}

const fixedNow = () => new Date('2026-10-17T18:00:00.000Z');

describe('Money (T1, T2)', () => {
  it('T1 stores whole minor units', () => {
    expect(Money.kes(150).minorUnits).toBe(150);
    expect(Money.kes(0).isZero()).toBe(true);
  });
  it('T1 rejects fractions, negatives, NaN and Infinity', () => {
    for (const bad of [1.5, 0.1 + 0.2, -1, NaN, Infinity]) {
      expect(() => Money.kes(bad)).toThrow(InvalidMoney);
    }
  });
  it('T2 arithmetic never produces a fractional unit', () => {
    expect(Money.kes(100).add(Money.kes(250)).minorUnits).toBe(350);
    expect(Money.kes(250).subtract(Money.kes(100)).minorUnits).toBe(150);
  });
  it('T2 subtraction below zero is rejected', () => {
    expect(() => Money.kes(100).subtract(Money.kes(101))).toThrow(InvalidMoney);
  });
  it('T2 overflow past safe integers is rejected', () => {
    expect(() => Money.kes(Number.MAX_SAFE_INTEGER).add(Money.kes(1))).toThrow(InvalidMoney);
  });
});

describe('transitionOrder: every pair of states', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (isAllowed(from, to)) {
        it(`T3 allows ${from} -> ${to}`, async () => {
          const store = new InMemoryOrderStore({ id: 'o1', status: from, history: [] });
          const result = await transitionOrder(store, 'o1', from, to, 'test', fixedNow);
          expect(result.status).toBe(to);
          expect((await store.get('o1'))!.status).toBe(to);
        });
      } else {
        it(`T4 rejects ${from} -> ${to}`, async () => {
          const store = new InMemoryOrderStore({ id: 'o1', status: from, history: [] });
          await expect(transitionOrder(store, 'o1', from, to, 'test', fixedNow)).rejects.toThrow(
            IllegalTransition,
          );
          expect((await store.get('o1'))!.status).toBe(from); // nothing was written
          expect(store.saveCalls).toBe(0);
        });
      }
    }
  }
});

describe('transitionOrder: other rules', () => {
  it('T5 throws StaleState when the stored status differs from expectedFrom', async () => {
    const store = new InMemoryOrderStore({ id: 'o1', status: 'PAID', history: [] });
    await expect(
      transitionOrder(store, 'o1', 'AWAITING_PAYMENT', 'PAID', 'callback-2', fixedNow),
    ).rejects.toThrow(StaleState);
    expect(store.saveCalls).toBe(0);
  });

  it('T5 the second of two identical callbacks is rejected, not applied twice', async () => {
    const store = new InMemoryOrderStore({ id: 'o1', status: 'AWAITING_PAYMENT', history: [] });
    await transitionOrder(store, 'o1', 'AWAITING_PAYMENT', 'PAID', 'callback-1', fixedNow);
    await expect(
      transitionOrder(store, 'o1', 'AWAITING_PAYMENT', 'PAID', 'callback-2', fixedNow),
    ).rejects.toThrow(StaleState);
    expect((await store.get('o1'))!.history).toHaveLength(1);
  });

  it('T6 appends history with server time and never edits earlier entries', async () => {
    const store = new InMemoryOrderStore({ id: 'o1', status: 'CREATED', history: [] });
    await transitionOrder(store, 'o1', 'CREATED', 'AWAITING_PAYMENT', 'payments-initiate', fixedNow);
    await transitionOrder(store, 'o1', 'AWAITING_PAYMENT', 'PAID', 'payments-callback', fixedNow);
    const history = (await store.get('o1'))!.history;
    expect(history).toEqual([
      { from: 'CREATED', to: 'AWAITING_PAYMENT', at: '2026-10-17T18:00:00.000Z', by: 'payments-initiate' },
      { from: 'AWAITING_PAYMENT', to: 'PAID', at: '2026-10-17T18:00:00.000Z', by: 'payments-callback' },
    ]);
  });

  it('T7 terminal states have no way out', () => {
    expect(TERMINAL_STATES).toEqual(['REFUNDED']);
    for (const to of ALL_STATES) expect(isAllowed('REFUNDED', to)).toBe(false);
  });

  it('T8 EXPIRED is never reopened', () => {
    expect(isAllowed('EXPIRED', 'AWAITING_PAYMENT')).toBe(false);
    expect(isAllowed('EXPIRED', 'CREATED')).toBe(false);
    expect(ALLOWED_TRANSITIONS.EXPIRED).toEqual(['PAID_LATE']);
  });

  it('T9 an unknown order throws OrderNotFound', async () => {
    const store = new InMemoryOrderStore();
    await expect(
      transitionOrder(store, 'nope', 'CREATED', 'AWAITING_PAYMENT', 'test', fixedNow),
    ).rejects.toThrow(OrderNotFound);
  });

  it('T10 every state except REFUNDED can eventually reach FULFILLED or REFUNDED (no dead ends)', () => {
    const canFinish = (s: (typeof ALL_STATES)[number], seen = new Set<string>()): boolean => {
      if (s === 'FULFILLED' || s === 'REFUNDED') return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return ALLOWED_TRANSITIONS[s].some((n) => canFinish(n, seen));
    };
    for (const s of ALL_STATES) expect(canFinish(s)).toBe(true);
  });
});
