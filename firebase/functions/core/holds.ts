// holds.ts
// Stock and holds. Truth lives in SHARDS (several small counters instead of one big
// one, because a single database document can only take about one write per second).
//
// THE INVARIANT this file exists to protect (for every shard and the product total):
//     remaining + held + sold  ==  the capacity we started with, and none is ever negative.
// Display counters are hints; only the transactions below decide who gets a unit.

import { Database, TransactionContention } from './database';
import { PaymentOrder, PreloadedOrderStore, orderPath } from './order-store';
import { transitionOrder } from './transition-order';
import { OrderStatus } from './order-states';

export type HoldStatus = 'ACTIVE' | 'CONVERTED' | 'EXPIRED' | 'RELEASED';

export interface Shard {
  remaining: number; // units nobody has claimed
  held: number; // units reserved by an ACTIVE hold (unpaid, timer running)
  sold: number; // units paid for
}

export interface Hold {
  id: string;
  userId: string;
  productId: string;
  shardId: string; // which shard we took the unit from: we must return it THERE
  status: HoldStatus;
  createdAt: string;
  expiresAt: string;
}

export const HOLD_TTL_SECONDS = 600; // 10 minutes
const MAX_CLAIM_ATTEMPTS = 40;

export const shardsPath = (productId: string) => `products/${productId}/shards`;
export const shardPath = (productId: string, shardId: string) => `${shardsPath(productId)}/${shardId}`;
export const holdPath = (holdId: string) => `holds/${holdId}`;

export class HoldNotFound extends Error {
  constructor(holdId: string) {
    super(`Hold ${holdId} not found`);
    this.name = 'HoldNotFound';
  }
}
export class HoldNotActive extends Error {
  constructor(holdId: string, status: HoldStatus) {
    super(`Hold ${holdId} is ${status}, not ACTIVE`);
    this.name = 'HoldNotActive';
  }
}

export type CreateHoldResult =
  | { kind: 'HELD'; hold: Hold }
  | { kind: 'ALL_RESERVED' } // nothing free, but unpaid holds may still return stock: offer waitlist
  | { kind: 'SOLD_OUT' } // everything is paid for: offer waitlist
  | { kind: 'BUSY' }; // stock exists but we kept colliding: ask the user to tap again

export interface CreateHoldOptions {
  productId: string;
  userId: string;
  now?: () => Date;
  ttlSeconds?: number;
  random?: () => number;
  newId?: () => string;
}

export async function createHold(db: Database, opts: CreateHoldOptions): Promise<CreateHoldResult> {
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const holdId = (opts.newId ?? (() => crypto.randomUUID()))(); // one id per REQUEST, reused on retries
  const ttl = opts.ttlSeconds ?? HOLD_TTL_SECONDS;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    // 1. Hint only: which shards look like they still have stock?
    const shards = await db.listCollection<Shard>(shardsPath(opts.productId));
    const candidates = shards.filter((s) => s.data.remaining > 0);

    if (candidates.length === 0) {
      // Every shard is empty. Sold out, or just temporarily reserved?
      const anyHeld = shards.some((s) => s.data.held > 0);
      return anyHeld ? { kind: 'ALL_RESERVED' } : { kind: 'SOLD_OUT' };
    }

    // 2. Pick RANDOMLY, so a crowd spreads over all drawers instead of piling on the first.
    const pick = candidates[Math.floor(random() * candidates.length)];
    const sPath = shardPath(opts.productId, pick.id);

    try {
      // 3. The only step that decides anything. All-or-nothing.
      const claimed = await db.runTransaction<Hold | null>(async (tx) => {
        const existing = await tx.get<Hold>(holdPath(holdId));
        if (existing) return existing; // a retried request must never take a SECOND unit

        const shard = await tx.get<Shard>(sPath); // re-read: the hint may be stale
        if (!shard || shard.remaining < 1) return null; // someone took it first

        const createdAt = now();
        const hold: Hold = {
          id: holdId,
          userId: opts.userId,
          productId: opts.productId,
          shardId: pick.id,
          status: 'ACTIVE',
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + ttl * 1000).toISOString(),
        };
        tx.set(sPath, { ...shard, remaining: shard.remaining - 1, held: shard.held + 1 });
        tx.set(holdPath(holdId), hold);
        return hold;
      });

      if (claimed) return { kind: 'HELD', hold: claimed };
      // claimed === null: that shard emptied under us. Loop: look again and try another.
    } catch (e) {
      if (!(e instanceof TransactionContention)) throw e;
      // Too many collisions on that shard: loop and try again (maybe a different shard).
    }
  }
  return { kind: 'BUSY' };
}

export type ExpireResult = 'EXPIRED' | 'IGNORED' | 'NOT_YET' | 'NOT_FOUND';

// An order whose hold times out is expired in the SAME transaction: stock back, hold EXPIRED,
// order EXPIRED. Orders in any other state (e.g. PAID) are never touched here.
const EXPIRABLE_ORDER_STATES: readonly OrderStatus[] = ['CREATED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED'];

// Called by the hold's timer (Cloud Task). Returns the unit to its shard, but ONLY if
// the hold is still ACTIVE. A paid (CONVERTED) hold must never give its unit back.
export async function expireHold(
  db: Database,
  holdId: string,
  now: () => Date = () => new Date(),
): Promise<ExpireResult> {
  return db.runTransaction<ExpireResult>(async (tx) => {
    const hold = await tx.get<Hold>(holdPath(holdId));
    if (!hold) return 'NOT_FOUND';
    if (hold.status !== 'ACTIVE') return 'IGNORED'; // already paid, expired or released
    if (now().getTime() < new Date(hold.expiresAt).getTime()) return 'NOT_YET'; // fired early

    const sPath = shardPath(hold.productId, hold.shardId);
    const shard = await tx.get<Shard>(sPath);
    if (!shard) throw new Error(`Shard ${hold.shardId} missing for hold ${holdId}`);
    const order = await tx.get<PaymentOrder>(orderPath(holdId)); // same id as the hold
    // ---- all reads done; writes from here ----

    tx.set(sPath, { ...shard, remaining: shard.remaining + 1, held: shard.held - 1 });
    tx.set(holdPath(holdId), { ...hold, status: 'EXPIRED' });
    if (order && EXPIRABLE_ORDER_STATES.includes(order.status)) {
      await transitionOrder(new PreloadedOrderStore(order, tx), order.id, order.status, 'EXPIRED', 'holds-expire', now);
    }
    return 'EXPIRED';
  });
}

// Called when payment succeeds. held -> sold. Allowed even if expiresAt has passed,
// as long as the timer has not fired yet: the unit is still ours, so we honour the payment.
export async function convertHold(db: Database, holdId: string): Promise<Hold> {
  return db.runTransaction<Hold>(async (tx) => {
    const hold = await tx.get<Hold>(holdPath(holdId));
    if (!hold) throw new HoldNotFound(holdId);
    if (hold.status !== 'ACTIVE') throw new HoldNotActive(holdId, hold.status); // PAID_LATE path (Slice 3)

    const sPath = shardPath(hold.productId, hold.shardId);
    const shard = await tx.get<Shard>(sPath);
    if (!shard) throw new Error(`Shard ${hold.shardId} missing for hold ${holdId}`);

    const converted: Hold = { ...hold, status: 'CONVERTED' };
    tx.set(sPath, { ...shard, held: shard.held - 1, sold: shard.sold + 1 });
    tx.set(holdPath(holdId), converted);
    return converted;
  });
}

// Safety net for timers that never ran: expire every ACTIVE hold whose time is up.
// Run on a schedule (e.g. every minute). Safe to run twice: expireHold ignores non-ACTIVE holds.
export async function sweepExpiredHolds(db: Database, now: () => Date = () => new Date()): Promise<number> {
  const holds = await db.listCollection<Hold>('holds');
  let expired = 0;
  for (const h of holds) {
    if (h.data.status === 'ACTIVE' && new Date(h.data.expiresAt).getTime() <= now().getTime()) {
      try {
        if ((await expireHold(db, h.id, now)) === 'EXPIRED') expired++;
      } catch (e) {
        if (!(e instanceof TransactionContention)) throw e; // collided: the next sweep gets it
      }
    }
  }
  return expired;
}
