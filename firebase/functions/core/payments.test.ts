// payments.test.ts
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { FakeDatabase } from './fake-database';
import { Transaction, TransactionContention } from './database';
import { FakeDaraja } from './fake-daraja';
import { normalizePhone, parseCallback } from './daraja';
import { Hold, Shard, HoldNotActive, createHold, expireHold, sweepExpiredHolds, shardPath, shardsPath, holdPath } from './holds';
import { PaymentOrder, orderPath } from './order-store';
import {
  Deps,
  Fulfiller,
  Forbidden,
  HoldExpired,
  Payment,
  PriceMissing,
  applyCallbackResult,
  createOrder,
  fulfilOrder,
  handlePaymentCallback,
  initiatePayment,
  paymentPath,
  productPath,
  reconcilePending,
  reconcilePayment,
  sweepPaidOrders,
} from './payments';

// ---------- test helpers ----------

class TicketFulfiller implements Fulfiller {
  fulfil(tx: Transaction, order: PaymentOrder): void {
    tx.set(`tickets/${order.id}-1`, { id: `${order.id}-1`, orderId: order.id, userId: order.userId, productId: order.productId, status: 'valid' });
  }
}

class FlakyFulfiller extends TicketFulfiller {
  failing = true;
  override fulfil(tx: Transaction, order: PaymentOrder): void {
    if (this.failing) throw new Error('ticket service is down');
    super.fulfil(tx, order);
  }
}

const T0 = new Date('2026-10-17T18:00:00.000Z').getTime();
const PRICE = 150000; // KES 1,500.00 in cents
const SHILLINGS = 1500;

function setup(shardCount = 4, perShard = 5, fulfiller: Fulfiller = new TicketFulfiller()) {
  const db = new FakeDatabase();
  const daraja = new FakeDaraja();
  let t = T0;
  const deps: Deps = { db, daraja, fulfiller, now: () => new Date(t) };
  for (let i = 0; i < shardCount; i++) {
    db.seed<Shard>(shardPath('concert', String(i)), { remaining: perShard, held: 0, sold: 0 });
  }
  db.seed(productPath('concert'), { price: PRICE });
  return { db, daraja, deps, advance: (seconds: number) => (t += seconds * 1000) };
}

async function holdFor(deps: Deps, userId: string): Promise<Hold> {
  const r = await createHold(deps.db, { productId: 'concert', userId, now: deps.now });
  if (r.kind !== 'HELD') throw new Error(`could not get a hold: ${r.kind}`);
  return r.hold;
}

async function startPayment(deps: Deps, userId: string, phone = '0712 345 678') {
  const hold = await holdFor(deps, userId);
  await createOrder(deps, { holdId: hold.id, userId });
  const init = await initiatePayment(deps, { orderId: hold.id, userId, phone });
  if (init.kind !== 'STARTED') throw new Error(`payment did not start: ${init.kind}`);
  return { hold, orderId: hold.id, checkoutId: init.checkoutRequestId };
}

async function order(db: FakeDatabase, id: string) {
  return db.peek<PaymentOrder>(orderPath(id))!;
}
async function count(db: FakeDatabase, collection: string) {
  return (await db.listCollection(collection)).length;
}
async function stock(db: FakeDatabase) {
  const shards = await db.listCollection<Shard>(shardsPath('concert'));
  return {
    remaining: shards.reduce((n, s) => n + s.data.remaining, 0),
    held: shards.reduce((n, s) => n + s.data.held, 0),
    sold: shards.reduce((n, s) => n + s.data.sold, 0),
    shards,
  };
}
// THE INVARIANT, from Slice 2, now checked after payments too.
async function assertInvariant(db: FakeDatabase, perShard: number) {
  const { shards } = await stock(db);
  for (const s of shards) {
    expect(s.data.remaining).toBeGreaterThanOrEqual(0);
    expect(s.data.held).toBeGreaterThanOrEqual(0);
    expect(s.data.sold).toBeGreaterThanOrEqual(0);
    expect(s.data.remaining + s.data.held + s.data.sold).toBe(perShard);
  }
}

// Models what the platform does when a call loses too many collisions: it is tried again.
async function retrying<T>(op: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 30; i++) {
    try {
      return await op();
    } catch (e) {
      if (!(e instanceof TransactionContention)) throw e;
    }
  }
  throw new Error('gave up after 30 retries');
}

// ---------- tests ----------

describe('phone numbers and callback parsing', () => {
  it('N1 phone numbers in every common format become 2547XXXXXXXX', () => {
    for (const input of ['0712345678', '0712 345 678', '+254712345678', '254712345678', '712345678', '0112345678']) {
      expect(normalizePhone(input)).toMatch(/^254[17]\d{8}$/);
    }
    expect(normalizePhone('0712 345 678')).toBe('254712345678');
  });
  it('N2 nonsense is rejected', () => {
    for (const input of ['', '12345', 'abcdefghij', '0812345678', '+1 555 123 4567']) {
      expect(normalizePhone(input)).toBeNull();
    }
  });
  it('N3 reads the real success callback, converting shillings to cents', () => {
    const body = new FakeDaraja().successBody('ws_CO_9', 1500, 'ABC123XYZ');
    expect(parseCallback(body)).toEqual({ checkoutRequestId: 'ws_CO_9', resultCode: 0, receipt: 'ABC123XYZ', amount: 150000 });
  });
  it('N4 reads the real failure callback (no metadata)', () => {
    expect(parseCallback(new FakeDaraja().failureBody('ws_CO_9', 1032))).toEqual({ checkoutRequestId: 'ws_CO_9', resultCode: 1032 });
  });
  it('N5 garbage gives null, never a crash', () => {
    for (const junk of [null, undefined, 42, 'hello', {}, { Body: {} }, { Body: { stkCallback: { ResultCode: 0 } } }]) {
      expect(parseCallback(junk)).toBeNull();
    }
  });
});

describe('createOrder', () => {
  it('C1 the price comes from the product, and the order shares the hold id', async () => {
    const { deps } = setup();
    const hold = await holdFor(deps, 'u1');
    const o = await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    expect(o).toMatchObject({ id: hold.id, holdId: hold.id, amount: PRICE, status: 'CREATED', userId: 'u1' });
  });
  it('C2 asking twice gives the same order, not a second one', async () => {
    const { db, deps } = setup();
    const hold = await holdFor(deps, 'u1');
    await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    expect(await count(db, 'orders')).toBe(1);
  });
  it("C3 nobody can make an order from someone else's hold", async () => {
    const { deps } = setup();
    const hold = await holdFor(deps, 'u1');
    await expect(createOrder(deps, { holdId: hold.id, userId: 'thief' })).rejects.toThrow(Forbidden);
  });
  it('C4 refuses an expired hold, a dead hold, and a product with no price', async () => {
    const { db, deps, advance } = setup();
    const h1 = await holdFor(deps, 'u1');
    advance(601);
    await expect(createOrder(deps, { holdId: h1.id, userId: 'u1' })).rejects.toThrow(HoldExpired); // time is up, timer not run yet
    await expireHold(db, h1.id, deps.now);
    await expect(createOrder(deps, { holdId: h1.id, userId: 'u1' })).rejects.toThrow(HoldNotActive);

    db.seed(productPath('concert'), {}); // price removed
    const h2 = await holdFor(deps, 'u2');
    await expect(createOrder(deps, { holdId: h2.id, userId: 'u2' })).rejects.toThrow(PriceMissing);
  });
});

describe('the happy path', () => {
  it('P1 hold -> order -> M-Pesa prompt -> callback -> paid -> ticket', async () => {
    const { db, daraja, deps } = setup();
    const { hold, orderId, checkoutId } = await startPayment(deps, 'u1');

    expect(daraja.pushes).toEqual([{ phone: '254712345678', amountShillings: SHILLINGS, reference: orderId }]);
    expect((await order(db, orderId)).status).toBe('AWAITING_PAYMENT');
    expect(db.peek<Payment>(paymentPath(checkoutId))!.status).toBe('PENDING');

    const outcome = await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS, 'RECEIPT1'));
    expect(outcome).toEqual({ kind: 'PAID', orderId });

    const final = await order(db, orderId);
    expect(final.status).toBe('FULFILLED');
    expect(final.history.map((h) => h.to)).toEqual(['AWAITING_PAYMENT', 'PAID', 'FULFILLED']);
    expect(db.peek<Payment>(paymentPath(checkoutId))).toMatchObject({ status: 'SUCCEEDED', receipt: 'RECEIPT1' });
    expect(db.peek<Hold>(holdPath(hold.id))!.status).toBe('CONVERTED');
    expect(await stock(db)).toMatchObject({ remaining: 19, held: 0, sold: 1 });
    expect(await count(db, 'tickets')).toBe(1);
    await assertInvariant(db, 5);
  });

  it('P2 the raw callback is stored before anything else', async () => {
    const { db, daraja, deps } = setup();
    const { checkoutId } = await startPayment(deps, 'u1');
    await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS));
    const log = await db.listCollection<{ body: string }>('callbackLog');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].data.body).Body.stkCallback.CheckoutRequestID).toBe(checkoutId);
  });
});

describe('duplicate and repeated callbacks', () => {
  it('D1 the same callback twice, one after the other: one ticket', async () => {
    const { db, daraja, deps } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    const body = daraja.successBody(checkoutId, SHILLINGS);
    expect((await handlePaymentCallback(deps, body)).kind).toBe('PAID');
    expect((await handlePaymentCallback(deps, body)).kind).toBe('DUPLICATE_CALLBACK');
    expect(await count(db, 'tickets')).toBe(1);
    expect((await order(db, orderId)).history).toHaveLength(3);
    expect((await stock(db)).sold).toBe(1);
  });

  it('D2 twenty identical callbacks at the SAME instant: exactly one wins', async () => {
    const { db, daraja, deps } = setup();
    const { checkoutId } = await startPayment(deps, 'u1');
    const body = daraja.successBody(checkoutId, SHILLINGS);
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => retrying(() => handlePaymentCallback(deps, body))));
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'DUPLICATE_CALLBACK')).toHaveLength(19);
    expect(await count(db, 'tickets')).toBe(1);
    expect((await stock(db)).sold).toBe(1);
    expect(await count(db, 'callbackLog')).toBe(20); // every raw copy was kept
    await assertInvariant(db, 5);
  });

  it('D3 a SECOND payment for an order that is already paid is marked DUPLICATE and flagged for refund', async () => {
    const { db, daraja, deps } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS));
    // A second attempt that slipped through (e.g. a race we did not foresee):
    db.seed<Payment>(paymentPath('ws_CO_second'), {
      id: 'ws_CO_second', orderId, userId: 'u1', amount: PRICE, phone: '254712345678', status: 'PENDING',
      purpose: 'ticket_purchase', sourceModule: 'events', referenceId: orderId, createdAt: new Date(T0).toISOString(),
    });
    const outcome = await handlePaymentCallback(deps, daraja.successBody('ws_CO_second', SHILLINGS));
    expect(outcome.kind).toBe('DUPLICATE_PAYMENT');
    expect(db.peek<Payment>(paymentPath('ws_CO_second'))!.status).toBe('DUPLICATE');
    expect(db.peek('flags/refund-ws_CO_second')).not.toBeNull();
    expect(await count(db, 'tickets')).toBe(1); // still one
    expect((await stock(db)).sold).toBe(1); // still one
  });
});

describe('failures and retries', () => {
  it('F1 customer cancels the prompt: order PAYMENT_FAILED, retry works, second attempt pays', async () => {
    const { db, daraja, deps } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    expect((await handlePaymentCallback(deps, daraja.failureBody(checkoutId, 1032))).kind).toBe('FAILED');
    expect((await order(db, orderId)).status).toBe('PAYMENT_FAILED');
    expect(db.peek<Payment>(paymentPath(checkoutId))!.status).toBe('FAILED');

    const retry = await initiatePayment(deps, { orderId, userId: 'u1', phone: '0712345678' });
    expect(retry).toEqual({ kind: 'STARTED', checkoutRequestId: 'ws_CO_2' });
    await handlePaymentCallback(deps, daraja.successBody('ws_CO_2', SHILLINGS));
    expect((await order(db, orderId)).status).toBe('FULFILLED');
    expect(await count(db, 'tickets')).toBe(1);
    await assertInvariant(db, 5);
  });

  it('F2 tapping pay while an attempt is unresolved says CONFIRMING and sends NO second prompt', async () => {
    const { daraja, deps } = setup();
    const { orderId } = await startPayment(deps, 'u1');
    expect(await initiatePayment(deps, { orderId, userId: 'u1', phone: '0712345678' })).toEqual({ kind: 'CONFIRMING' });
    expect(daraja.pushes).toHaveLength(1);
  });

  it('F3 M-Pesa rejects the prompt: order PAYMENT_FAILED, and a retry works', async () => {
    const { db, daraja, deps } = setup();
    const hold = await holdFor(deps, 'u1');
    await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    daraja.failNextPush = 'REJECT';
    expect(await initiatePayment(deps, { orderId: hold.id, userId: 'u1', phone: '0712345678' })).toEqual({ kind: 'PUSH_FAILED' });
    expect((await order(db, hold.id)).status).toBe('PAYMENT_FAILED');
    expect((await initiatePayment(deps, { orderId: hold.id, userId: 'u1', phone: '0712345678' })).kind).toBe('STARTED');
  });

  it('F4 a bad phone number sends nothing and changes nothing', async () => {
    const { db, daraja, deps } = setup();
    const hold = await holdFor(deps, 'u1');
    await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    expect(await initiatePayment(deps, { orderId: hold.id, userId: 'u1', phone: '12345' })).toEqual({ kind: 'BAD_PHONE' });
    expect(daraja.pushes).toHaveLength(0);
    expect((await order(db, hold.id)).status).toBe('CREATED');
  });

  it("F5 nobody can pay for someone else's order", async () => {
    const { deps } = setup();
    const hold = await holdFor(deps, 'u1');
    await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    await expect(initiatePayment(deps, { orderId: hold.id, userId: 'thief', phone: '0712345678' })).rejects.toThrow(Forbidden);
  });

  it('F6 paying after the hold ran out of time is refused, even before the timer fires', async () => {
    const { db, daraja, deps, advance } = setup();
    const hold = await holdFor(deps, 'u1');
    await createOrder(deps, { holdId: hold.id, userId: 'u1' });
    advance(601);
    expect(await initiatePayment(deps, { orderId: hold.id, userId: 'u1', phone: '0712345678' })).toEqual({ kind: 'NOT_PAYABLE', reason: 'HOLD_EXPIRED' });
    expect(daraja.pushes).toHaveLength(0);
    expect((await order(db, hold.id)).status).toBe('CREATED');
  });
});

describe('timers and orders', () => {
  it('T1 a hold timing out also expires its order (CREATED or AWAITING_PAYMENT) and returns the unit', async () => {
    const { db, deps, advance } = setup();
    const a = await holdFor(deps, 'a');
    await createOrder(deps, { holdId: a.id, userId: 'a' }); // CREATED
    const b = await startPayment(deps, 'b'); // AWAITING_PAYMENT
    advance(601);
    expect(await expireHold(db, a.id, deps.now)).toBe('EXPIRED');
    expect(await expireHold(db, b.hold.id, deps.now)).toBe('EXPIRED');
    expect((await order(db, a.id)).status).toBe('EXPIRED');
    expect((await order(db, b.orderId)).status).toBe('EXPIRED');
    expect(await stock(db)).toMatchObject({ remaining: 20, held: 0, sold: 0 });
  });

  it('T2 a paid order is untouched when the timer fires later', async () => {
    const { db, daraja, deps, advance } = setup();
    const { hold, orderId, checkoutId } = await startPayment(deps, 'u1');
    await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS));
    advance(601);
    expect(await expireHold(db, hold.id, deps.now)).toBe('IGNORED');
    expect((await order(db, orderId)).status).toBe('FULFILLED');
    expect((await stock(db)).sold).toBe(1);
  });

  it('T3 the sweeper expires due holds and leaves fresh ones alone', async () => {
    const { db, deps, advance } = setup();
    await holdFor(deps, 'a');
    await holdFor(deps, 'b');
    advance(601);
    await holdFor(deps, 'fresh');
    expect(await sweepExpiredHolds(db, deps.now)).toBe(2);
    expect(await stock(db)).toMatchObject({ remaining: 19, held: 1 });
  });
});

describe('late payments (money after the timer)', () => {
  it('L1 stock still free: the late payment is ticketed', async () => {
    const { db, daraja, deps, advance } = setup();
    const { hold, orderId, checkoutId } = await startPayment(deps, 'u1');
    advance(601);
    await expireHold(db, hold.id, deps.now);
    expect((await order(db, orderId)).status).toBe('EXPIRED');

    const outcome = await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS));
    expect(outcome).toEqual({ kind: 'PAID_LATE', orderId });
    expect((await order(db, orderId)).status).toBe('FULFILLED');
    expect(await count(db, 'tickets')).toBe(1);
    expect(await stock(db)).toMatchObject({ remaining: 19, held: 0, sold: 1 });
    await assertInvariant(db, 5);
  });

  it('L2 stock gone: the late payment is refunded, nobody gets a second ticket for one unit', async () => {
    const { db, daraja, deps, advance } = setup(1, 1); // ONE ticket in the whole shop
    const a = await startPayment(deps, 'late-payer');
    advance(601);
    await expireHold(db, a.hold.id, deps.now);

    const b = await startPayment(deps, 'quick-buyer'); // takes the freed unit
    await handlePaymentCallback(deps, daraja.successBody(b.checkoutId, SHILLINGS));
    expect((await order(db, b.orderId)).status).toBe('FULFILLED');

    const outcome = await handlePaymentCallback(deps, daraja.successBody(a.checkoutId, SHILLINGS));
    expect(outcome.kind).toBe('PAID_LATE');
    expect((await order(db, a.orderId)).status).toBe('REFUND_PENDING');
    expect(await count(db, 'tickets')).toBe(1);
    expect((await stock(db)).sold).toBe(1);
    await assertInvariant(db, 1);
  });
});

describe('reconciliation (callbacks that never came)', () => {
  it('R1 silent attempt that really succeeded gets settled and ticketed', async () => {
    const { db, daraja, deps, advance } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    daraja.statuses.set(checkoutId, { kind: 'SUCCESS' });
    advance(200);
    expect(await reconcilePending(deps)).toBe(1);
    expect((await order(db, orderId)).status).toBe('FULFILLED');
    expect(await count(db, 'tickets')).toBe(1);
  });

  it('R2 silent attempt that really failed lets the customer retry', async () => {
    const { db, daraja, deps, advance } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    daraja.statuses.set(checkoutId, { kind: 'FAILED', resultCode: 1037 });
    advance(200);
    await reconcilePending(deps);
    expect((await order(db, orderId)).status).toBe('PAYMENT_FAILED');
    expect((await initiatePayment(deps, { orderId, userId: 'u1', phone: '0712345678' })).kind).toBe('STARTED');
  });

  it('R3 still-pending and too-recent attempts are left alone', async () => {
    const { db, daraja, deps, advance } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    daraja.statuses.set(checkoutId, { kind: 'SUCCESS' });
    advance(60); // younger than 180 seconds: skipped even though M-Pesa would say SUCCESS
    expect(await reconcilePending(deps)).toBe(0);
    expect((await order(db, orderId)).status).toBe('AWAITING_PAYMENT');
    advance(200);
    daraja.statuses.set(checkoutId, { kind: 'PENDING' }); // old enough, but M-Pesa cannot tell yet
    expect(await reconcilePending(deps)).toBe(0);
    expect((await order(db, orderId)).status).toBe('AWAITING_PAYMENT');
  });

  it('R4 reconciling an attempt whose callback already arrived does nothing', async () => {
    const { daraja, deps } = setup();
    const { checkoutId } = await startPayment(deps, 'u1');
    await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS));
    expect(await reconcilePayment(deps, checkoutId)).toBe('NOT_PENDING');
  });
});

describe('things that do not add up', () => {
  it('O1 a callback for an attempt we never recorded is an ORPHAN: flagged, not lost', async () => {
    const { db, daraja, deps } = setup();
    const outcome = await handlePaymentCallback(deps, daraja.successBody('ws_CO_unknown', SHILLINGS));
    expect(outcome.kind).toBe('ORPHAN');
    expect(db.peek('flags/orphan-ws_CO_unknown')).not.toBeNull();
    expect(await count(db, 'callbackLog')).toBe(1);
    expect(await count(db, 'tickets')).toBe(0);
  });

  it('O2 paying a different amount is sent to REVIEW: no tickets, order stays put', async () => {
    const { db, daraja, deps } = setup();
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    expect((await handlePaymentCallback(deps, daraja.successBody(checkoutId, 1000))).kind).toBe('REVIEW');
    expect((await order(db, orderId)).status).toBe('AWAITING_PAYMENT');
    expect(db.peek<Payment>(paymentPath(checkoutId))!.status).toBe('REVIEW');
    expect(db.peek(`flags/review-${checkoutId}`)).not.toBeNull();
    expect(await count(db, 'tickets')).toBe(0);
  });

  it('O3 garbage is stored and answered, never a crash', async () => {
    const { db, deps } = setup();
    for (const junk of ['hello', null, { nonsense: true }]) {
      expect((await handlePaymentCallback(deps, junk)).kind).toBe('BAD_PAYLOAD');
    }
    expect(await count(db, 'callbackLog')).toBe(3);
  });
});

describe('recovery tools', () => {
  it('S1 paid but the ticket service was down: the sweeper finishes the job', async () => {
    const flaky = new FlakyFulfiller();
    const { db, daraja, deps } = setup(4, 5, flaky);
    const { orderId, checkoutId } = await startPayment(deps, 'u1');
    await handlePaymentCallback(deps, daraja.successBody(checkoutId, SHILLINGS));
    expect((await order(db, orderId)).status).toBe('PAID'); // paid, no ticket yet
    expect(await count(db, 'tickets')).toBe(0);

    flaky.failing = false;
    expect(await sweepPaidOrders(deps)).toBe(1);
    expect((await order(db, orderId)).status).toBe('FULFILLED');
    expect(await count(db, 'tickets')).toBe(1);
    expect(await fulfilOrder(deps, orderId)).toBe('ALREADY_DONE'); // running it again is harmless
  });

  it('S2 the fake database enforces Firestore reads-before-writes', async () => {
    const db = new FakeDatabase();
    await expect(
      db.runTransaction(async (tx) => {
        tx.set('a/1', { x: 1 });
        await tx.get('a/2');
      }),
    ).rejects.toThrow(/reads before any writes/);
  });
});

describe('THE STORM, end to end', () => {
  it('X1 200 buyers, 50 tickets: every paid buyer gets exactly one ticket, 20% of callbacks lost then recovered', async () => {
    const { db, daraja, deps, advance } = setup(10, 5); // 50 tickets
    const lost = new Map<string, string>(); // userId -> checkoutId for buyers whose callback never arrives

    async function journey(i: number): Promise<void> {
      const userId = `user${i}`;
      let hold: Hold | null = null;
      for (let tries = 0; tries < 10 && !hold; tries++) {
        const r = await createHold(db, { productId: 'concert', userId, now: deps.now });
        if (r.kind === 'HELD') hold = r.hold;
        else if (r.kind !== 'BUSY') return; // sold out or all reserved: this buyer is done
      }
      if (!hold) return;
      await retrying(() => createOrder(deps, { holdId: hold!.id, userId }));
      const init = await retrying(() => initiatePayment(deps, { orderId: hold!.id, userId, phone: '0712345678' }));
      if (init.kind !== 'STARTED') throw new Error(`unexpected: ${init.kind}`);

      if (i % 5 === 0) {
        lost.set(userId, init.checkoutRequestId); // callback never arrives
        return;
      }
      const body = daraja.successBody(init.checkoutRequestId, SHILLINGS);
      await Promise.all([retrying(() => handlePaymentCallback(deps, body)), retrying(() => handlePaymentCallback(deps, body))]); // delivered twice
    }

    await Promise.all(Array.from({ length: 200 }, (_, i) => journey(i)));

    // Recovery: M-Pesa says the "lost" buyers did pay. Reconciliation settles them.
    for (const id of lost.values()) daraja.statuses.set(id, { kind: 'SUCCESS' });
    advance(200);
    await reconcilePending(deps);

    const orders = await db.listCollection<PaymentOrder>('orders');
    const payments = await db.listCollection<Payment>('payments');
    expect(orders).toHaveLength(50); // 50 tickets, 50 orders: nobody else got a hold
    expect(orders.every((o) => o.data.status === 'FULFILLED')).toBe(true);
    expect(payments.every((p) => p.data.status === 'SUCCEEDED')).toBe(true);
    expect(await count(db, 'tickets')).toBe(50); // one per paid buyer, never more
    expect(await stock(db)).toMatchObject({ remaining: 0, held: 0, sold: 50 });
    expect(new Set(orders.map((o) => o.data.userId)).size).toBe(50);
    await assertInvariant(db, 5);
    expect(db.retries).toBeGreaterThan(0); // collisions really happened
  });
});
