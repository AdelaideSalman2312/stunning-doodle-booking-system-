// payments.ts
// From "I hold a ticket" to "I have a ticket": orders, M-Pesa payments, callbacks,
// late payments, reconciliation. Every state change goes through transitionOrder.
//
// THREE RULES this file lives by:
//  1. All reads before any writes inside one transaction (Firestore insists on it).
//  2. Network calls (M-Pesa) NEVER happen inside a transaction: a transaction can be re-run.
//  3. Anything that can fail halfway leaves a state a sweeper can finish (see the sweepers).

import { Database, Transaction, TransactionContention } from './database';
import { CallbackResult, Daraja, normalizePhone, parseCallback } from './daraja';
import { Hold, HoldNotActive, HoldNotFound, Shard, holdPath, shardPath, shardsPath } from './holds';
import { PaymentOrder, PreloadedOrderStore, orderPath } from './order-store';
import { transitionOrder } from './transition-order';

// ---------- types ----------

export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'DUPLICATE' | 'REVIEW';

export interface Payment {
  id: string; // the CheckoutRequestID: ONE document per M-Pesa attempt, so duplicates collide here
  orderId: string;
  userId: string;
  amount: number; // minor units
  phone: string;
  status: PaymentStatus;
  purpose: string; // which module asked for this payment
  sourceModule: string;
  referenceId: string; // that module's own record (the order id)
  createdAt: string;
  receipt?: string;
  resultCode?: number;
}

// Creates the tickets for an order. Version 1 plugs the real, signed implementation in
// (next slice). It may only SET documents: all reads were done before it is called.
export interface Fulfiller {
  fulfil(tx: Transaction, order: PaymentOrder): void;
}

export interface Deps {
  db: Database;
  daraja: Daraja;
  fulfiller: Fulfiller;
  now?: () => Date;
  newId?: () => string;
  random?: () => number;
}

export class Forbidden extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Forbidden';
  }
}
export class HoldExpired extends Error {
  constructor(holdId: string) {
    super(`Hold ${holdId} has run out of time`);
    this.name = 'HoldExpired';
  }
}
export class PriceMissing extends Error {
  constructor(productId: string) {
    super(`Product ${productId} has no valid price`);
    this.name = 'PriceMissing';
  }
}

export const productPath = (productId: string) => `products/${productId}`;
export const paymentPath = (paymentId: string) => `payments/${paymentId}`;

const clockOf = (d: Deps) => d.now ?? (() => new Date());
const idOf = (d: Deps) => (d.newId ?? (() => crypto.randomUUID()))();

// ---------- 1. create the order ----------

// The price is read from the product ON THE SERVER. The phone never says what something costs.
export async function createOrder(deps: Deps, args: { holdId: string; userId: string }): Promise<PaymentOrder> {
  const clock = clockOf(deps);
  return deps.db.runTransaction<PaymentOrder>(async (tx) => {
    const hold = await tx.get<Hold>(holdPath(args.holdId));
    if (!hold) throw new HoldNotFound(args.holdId);
    const existing = await tx.get<PaymentOrder>(orderPath(args.holdId));
    const product = await tx.get<{ price: number }>(productPath(hold.productId));

    if (hold.userId !== args.userId) throw new Forbidden('This hold belongs to someone else');
    if (existing) return existing; // asking twice gives the same order, never two
    if (hold.status !== 'ACTIVE') throw new HoldNotActive(hold.id, hold.status);
    if (clock().getTime() >= new Date(hold.expiresAt).getTime()) throw new HoldExpired(hold.id);
    if (!product || !Number.isSafeInteger(product.price) || product.price <= 0) {
      throw new PriceMissing(hold.productId);
    }

    const order: PaymentOrder = {
      id: hold.id,
      userId: args.userId,
      holdId: hold.id,
      productId: hold.productId,
      amount: product.price,
      status: 'CREATED',
      history: [],
    };
    tx.set(orderPath(order.id), order);
    return order;
  });
}

// ---------- 2. start the payment ----------

export type InitiateResult =
  | { kind: 'STARTED'; checkoutRequestId: string }
  | { kind: 'CONFIRMING' } // an earlier attempt is unresolved: show "confirming", never a retry button
  | { kind: 'NOT_PAYABLE'; reason: 'NO_ORDER' | 'WRONG_STATE' | 'HOLD_EXPIRED' }
  | { kind: 'BAD_PHONE' }
  | { kind: 'PUSH_FAILED' };

type Gate = Exclude<InitiateResult, { kind: 'STARTED' } | { kind: 'BAD_PHONE' } | { kind: 'PUSH_FAILED' }> | { kind: 'GO'; amount: number };

export async function initiatePayment(
  deps: Deps,
  args: { orderId: string; userId: string; phone: string },
): Promise<InitiateResult> {
  const clock = clockOf(deps);
  const phone = normalizePhone(args.phone);
  if (!phone) return { kind: 'BAD_PHONE' };

  // Step A: check everything and move the order to AWAITING_PAYMENT (one transaction).
  const gate = await deps.db.runTransaction<Gate>(async (tx) => {
    const order = await tx.get<PaymentOrder>(orderPath(args.orderId));
    if (!order) return { kind: 'NOT_PAYABLE', reason: 'NO_ORDER' };
    if (order.userId !== args.userId) throw new Forbidden('This order belongs to someone else');
    const hold = await tx.get<Hold>(holdPath(order.holdId));

    // An earlier attempt may have worked even though we have not heard yet: do not charge twice.
    if (order.status === 'AWAITING_PAYMENT') return { kind: 'CONFIRMING' };
    if (order.status !== 'CREATED' && order.status !== 'PAYMENT_FAILED') {
      return { kind: 'NOT_PAYABLE', reason: 'WRONG_STATE' };
    }
    if (!hold || hold.status !== 'ACTIVE' || clock().getTime() >= new Date(hold.expiresAt).getTime()) {
      return { kind: 'NOT_PAYABLE', reason: 'HOLD_EXPIRED' };
    }
    if (order.amount % 100 !== 0) throw new Error('M-Pesa takes whole shillings: price must be a multiple of 100');

    await transitionOrder(new PreloadedOrderStore(order, tx), order.id, order.status, 'AWAITING_PAYMENT', 'payments-initiate', clock);
    return { kind: 'GO', amount: order.amount };
  });
  if (gate.kind !== 'GO') return gate;

  // Step B: the network call. Outside any transaction.
  let checkoutRequestId: string;
  try {
    const pushed = await deps.daraja.stkPush({ phone, amountShillings: gate.amount / 100, reference: args.orderId });
    checkoutRequestId = pushed.checkoutRequestId;
  } catch {
    // Rejected or unreachable. We mark the attempt failed so the customer can try again.
    // (A timeout can hide a push that DID go out. If its callback ever arrives it is flagged
    //  as an ORPHAN for a person to review and refund. See applyCallbackResult.)
    await deps.db.runTransaction(async (tx) => {
      const order = await tx.get<PaymentOrder>(orderPath(args.orderId));
      if (order && order.status === 'AWAITING_PAYMENT') {
        await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'AWAITING_PAYMENT', 'PAYMENT_FAILED', 'payments-initiate', clock);
      }
    });
    return { kind: 'PUSH_FAILED' };
  }

  // Step C: record the attempt, keyed by Daraja's id.
  await deps.db.runTransaction(async (tx) => {
    const order = await tx.get<PaymentOrder>(orderPath(args.orderId));
    if (!order) throw new Error(`Order ${args.orderId} vanished`);
    const payment: Payment = {
      id: checkoutRequestId,
      orderId: order.id,
      userId: args.userId,
      amount: order.amount,
      phone,
      status: 'PENDING',
      purpose: 'ticket_purchase',
      sourceModule: 'events',
      referenceId: order.id,
      createdAt: clock().toISOString(),
    };
    tx.set(paymentPath(checkoutRequestId), payment);
    tx.set(orderPath(order.id), { ...order, paymentId: checkoutRequestId });
  });
  return { kind: 'STARTED', checkoutRequestId };
}

// ---------- 3. the callback ----------

export type CallbackOutcome =
  | { kind: 'PAID'; orderId: string }
  | { kind: 'PAID_LATE'; orderId: string }
  | { kind: 'FAILED' }
  | { kind: 'DUPLICATE_CALLBACK' } // same attempt reported twice: nothing changes
  | { kind: 'DUPLICATE_PAYMENT' } // a SECOND payment for an order already paid: needs a refund
  | { kind: 'ORPHAN' } // a callback for an attempt we have no record of: a person must look
  | { kind: 'REVIEW' } // something does not add up (amount, missing order): a person must look
  | { kind: 'BAD_PAYLOAD' };

// One transaction decides what a payment result means. Safe to call twice for the same attempt.
export async function applyCallbackResult(deps: Deps, result: CallbackResult): Promise<CallbackOutcome> {
  const clock = clockOf(deps);
  return deps.db.runTransaction<CallbackOutcome>(async (tx) => {
    const payment = await tx.get<Payment>(paymentPath(result.checkoutRequestId));
    if (!payment) {
      tx.set(`flags/orphan-${result.checkoutRequestId}`, {
        kind: 'ORPHAN',
        checkoutRequestId: result.checkoutRequestId,
        resultCode: result.resultCode,
        at: clock().toISOString(),
      });
      return { kind: 'ORPHAN' };
    }
    // The heart of idempotency: only a PENDING payment can be settled. Anything else is a repeat.
    if (payment.status !== 'PENDING') return { kind: 'DUPLICATE_CALLBACK' };

    const order = await tx.get<PaymentOrder>(orderPath(payment.orderId));
    const hold = order ? await tx.get<Hold>(holdPath(order.holdId)) : null;
    const shard = hold ? await tx.get<Shard>(shardPath(hold.productId, hold.shardId)) : null;
    // ---- all reads done; writes from here ----

    const settled = (status: PaymentStatus): Payment => ({
      ...payment,
      status,
      resultCode: result.resultCode,
      ...(result.receipt ? { receipt: result.receipt } : {}), // Firestore refuses undefined values
    });
    const review = (): CallbackOutcome => {
      tx.set(paymentPath(payment.id), settled('REVIEW'));
      tx.set(`flags/review-${payment.id}`, { kind: 'REVIEW', paymentId: payment.id, at: clock().toISOString() });
      return { kind: 'REVIEW' };
    };

    // The customer did not pay (cancelled, wrong PIN, no money, timed out).
    if (result.resultCode !== 0) {
      tx.set(paymentPath(payment.id), settled('FAILED'));
      if (order && order.status === 'AWAITING_PAYMENT') {
        await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'AWAITING_PAYMENT', 'PAYMENT_FAILED', 'payments-callback', clock);
      }
      return { kind: 'FAILED' };
    }

    // The customer paid.
    if (!order) return review();
    if (result.amount !== undefined && result.amount !== payment.amount) return review(); // paid a different amount

    switch (order.status) {
      case 'AWAITING_PAYMENT': {
        // The unit is still ours as long as the timer has not fired, even if expiresAt has passed.
        if (!hold || hold.status !== 'ACTIVE' || !shard) return review();
        tx.set(shardPath(hold.productId, hold.shardId), { ...shard, held: shard.held - 1, sold: shard.sold + 1 });
        tx.set(holdPath(hold.id), { ...hold, status: 'CONVERTED' });
        tx.set(paymentPath(payment.id), settled('SUCCEEDED'));
        await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'AWAITING_PAYMENT', 'PAID', 'payments-callback', clock);
        return { kind: 'PAID', orderId: order.id };
      }
      case 'EXPIRED': {
        // Money arrived after the hold timed out and the unit went back on sale.
        tx.set(paymentPath(payment.id), settled('SUCCEEDED'));
        await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'EXPIRED', 'PAID_LATE', 'payments-callback', clock);
        return { kind: 'PAID_LATE', orderId: order.id };
      }
      default: {
        // The order is already paid (or beyond). This is a second payment: refund it.
        tx.set(paymentPath(payment.id), settled('DUPLICATE'));
        tx.set(`flags/refund-${payment.id}`, { kind: 'REFUND', paymentId: payment.id, at: clock().toISOString() });
        return { kind: 'DUPLICATE_PAYMENT' };
      }
    }
  });
}

// The function Daraja calls. It stores the raw body FIRST, then processes. The HTTP wrapper
// answers 200 straight away whatever happens here (version 2: the real endpoint).
export async function handlePaymentCallback(deps: Deps, body: unknown): Promise<CallbackOutcome> {
  const clock = clockOf(deps);
  const logId = idOf(deps);
  await deps.db.runTransaction(async (tx) => {
    tx.set(`callbackLog/${logId}`, { receivedAt: clock().toISOString(), body: JSON.stringify(body) ?? 'null' });
  });
  const parsed = parseCallback(body);
  if (!parsed) return { kind: 'BAD_PAYLOAD' };
  const outcome = await applyCallbackResult(deps, parsed);
  await afterOutcome(deps, outcome);
  return outcome;
}

async function afterOutcome(deps: Deps, outcome: CallbackOutcome): Promise<void> {
  if (outcome.kind === 'PAID' || outcome.kind === 'PAID_LATE') {
    try {
      await fulfilOrder(deps, outcome.orderId);
    } catch {
      // Paid but not yet ticketed. The sweeper (sweepPaidOrders) finishes the job.
    }
  }
}

// ---------- 4. tickets, and late payments ----------

export type FulfilResult = 'FULFILLED' | 'REFUND_PENDING' | 'NOT_READY' | 'ALREADY_DONE' | 'RETRY_LATER';

// PAID -> tickets -> FULFILLED. PAID_LATE -> try to take a unit back from stock ->
// FULFILLED, or REFUND_PENDING if the stock is gone. Safe to call repeatedly.
export async function fulfilOrder(deps: Deps, orderId: string): Promise<FulfilResult> {
  const clock = clockOf(deps);
  const random = deps.random ?? Math.random;
  const first = await deps.db.getDocument<PaymentOrder>(orderPath(orderId));
  if (!first) return 'NOT_READY';
  if (first.status === 'FULFILLED' || first.status === 'REFUND_PENDING' || first.status === 'REFUNDED') return 'ALREADY_DONE';

  if (first.status === 'PAID') {
    return deps.db.runTransaction<FulfilResult>(async (tx) => {
      const order = await tx.get<PaymentOrder>(orderPath(orderId));
      if (!order || order.status !== 'PAID') return 'ALREADY_DONE';
      deps.fulfiller.fulfil(tx, order);
      await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'PAID', 'FULFILLED', 'tickets-issue', clock);
      return 'FULFILLED';
    });
  }

  if (first.status === 'PAID_LATE') {
    for (let attempt = 0; attempt < 40; attempt++) {
      const shards = await deps.db.listCollection<Shard>(shardsPath(first.productId));
      const candidates = shards.filter((s) => s.data.remaining > 0);

      if (candidates.length === 0) {
        // The unit was sold to someone else: give the money back.
        return deps.db.runTransaction<FulfilResult>(async (tx) => {
          const order = await tx.get<PaymentOrder>(orderPath(orderId));
          if (!order || order.status !== 'PAID_LATE') return 'ALREADY_DONE';
          await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'PAID_LATE', 'REFUND_PENDING', 'payments-late', clock);
          return 'REFUND_PENDING';
        });
      }

      const pick = candidates[Math.floor(random() * candidates.length)];
      const sPath = shardPath(first.productId, pick.id);
      try {
        const outcome = await deps.db.runTransaction<FulfilResult | 'RETRY'>(async (tx) => {
          const order = await tx.get<PaymentOrder>(orderPath(orderId));
          if (!order || order.status !== 'PAID_LATE') return 'ALREADY_DONE';
          const shard = await tx.get<Shard>(sPath);
          if (!shard || shard.remaining < 1) return 'RETRY'; // someone took it first
          tx.set(sPath, { ...shard, remaining: shard.remaining - 1, sold: shard.sold + 1 });
          deps.fulfiller.fulfil(tx, order);
          await transitionOrder(new PreloadedOrderStore(order, tx), order.id, 'PAID_LATE', 'FULFILLED', 'tickets-issue', clock);
          return 'FULFILLED';
        });
        if (outcome !== 'RETRY') return outcome;
      } catch (e) {
        if (!(e instanceof TransactionContention)) throw e;
      }
    }
    return 'RETRY_LATER';
  }
  return 'NOT_READY';
}

// ---------- 5. reconciliation and sweepers (the recovery tools) ----------

export type ReconcileResult = 'SETTLED' | 'STILL_PENDING' | 'NOT_PENDING';

// Asks M-Pesa what really happened to one attempt whose callback never came.
export async function reconcilePayment(deps: Deps, checkoutRequestId: string): Promise<ReconcileResult> {
  const payment = await deps.db.getDocument<Payment>(paymentPath(checkoutRequestId));
  if (!payment || payment.status !== 'PENDING') return 'NOT_PENDING';
  const answer = await deps.daraja.queryStatus(checkoutRequestId);
  if (answer.kind === 'PENDING') return 'STILL_PENDING';
  const result: CallbackResult = {
    checkoutRequestId,
    resultCode: answer.kind === 'SUCCESS' ? 0 : answer.resultCode,
  };
  const outcome = await applyCallbackResult(deps, result);
  await afterOutcome(deps, outcome);
  return 'SETTLED';
}

// Run on a schedule. Settles every attempt that has been silent for too long.
export async function reconcilePending(deps: Deps, olderThanSeconds = 180): Promise<number> {
  const cutoff = clockOf(deps)().getTime() - olderThanSeconds * 1000;
  const payments = await deps.db.listCollection<Payment>('payments');
  let settled = 0;
  for (const p of payments) {
    if (p.data.status !== 'PENDING' || new Date(p.data.createdAt).getTime() > cutoff) continue;
    try {
      if ((await reconcilePayment(deps, p.id)) === 'SETTLED') settled++;
    } catch (e) {
      if (!(e instanceof TransactionContention)) throw e; // the next run gets it
    }
  }
  return settled;
}

// Run on a schedule. Finishes any order that was paid but never got its tickets.
export async function sweepPaidOrders(deps: Deps): Promise<number> {
  const orders = await deps.db.listCollection<PaymentOrder>('orders');
  let done = 0;
  for (const o of orders) {
    if (o.data.status !== 'PAID' && o.data.status !== 'PAID_LATE') continue;
    try {
      const r = await fulfilOrder(deps, o.id);
      if (r === 'FULFILLED' || r === 'REFUND_PENDING') done++;
    } catch (e) {
      if (!(e instanceof TransactionContention)) throw e;
    }
  }
  return done;
}
