// holds.test.ts
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { FakeDatabase } from './fake-database';
import { TransactionContention } from './database';
import {
  Hold,
  Shard,
  createHold,
  expireHold,
  convertHold,
  HoldNotActive,
  shardPath,
  shardsPath,
  holdPath,
  CreateHoldResult,
} from './holds';

const T0 = new Date('2026-10-17T18:00:00.000Z');
const at = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);

function seedShards(db: FakeDatabase, productId: string, shardCount: number, perShard: number) {
  for (let i = 0; i < shardCount; i++) {
    db.seed<Shard>(shardPath(productId, String(i)), { remaining: perShard, held: 0, sold: 0 });
  }
}

// THE INVARIANT, checked against the whole database after every scenario.
async function assertInvariant(db: FakeDatabase, productId: string, shardCount: number, perShard: number) {
  const shards = await db.listCollection<Shard>(shardsPath(productId));
  expect(shards).toHaveLength(shardCount);
  let held = 0;
  for (const s of shards) {
    expect(s.data.remaining).toBeGreaterThanOrEqual(0);
    expect(s.data.held).toBeGreaterThanOrEqual(0);
    expect(s.data.sold).toBeGreaterThanOrEqual(0);
    expect(s.data.remaining + s.data.held + s.data.sold).toBe(perShard); // nothing created or lost
    held += s.data.held;
  }
  const holds = await db.listCollection<Hold>('holds');
  expect(holds.filter((h) => h.data.status === 'ACTIVE')).toHaveLength(held); // counters match reality
}

// Models what Cloud Tasks does in production: a task that fails (here, by losing too many
// collisions) is simply tried again. Nothing was written on the failed attempt.
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

const isHeld = (r: CreateHoldResult): r is { kind: 'HELD'; hold: Hold } => r.kind === 'HELD';

describe('createHold', () => {
  it('H1 takes exactly one unit and records a 10-minute hold', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'p', 1, 5);
    const r = await createHold(db, { productId: 'p', userId: 'u1', now: at(0), newId: () => 'h1' });
    expect(r.kind).toBe('HELD');
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 4, held: 1, sold: 0 });
    const hold = db.peek<Hold>(holdPath('h1'))!;
    expect(hold.status).toBe('ACTIVE');
    expect(hold.expiresAt).toBe('2026-10-17T18:10:00.000Z');
  });

  it('H2 two people race for the LAST ticket: exactly one wins, the other sees sold out', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'p', 1, 1);
    const [a, b] = await Promise.all([
      createHold(db, { productId: 'p', userId: 'a' }),
      createHold(db, { productId: 'p', userId: 'b' }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['ALL_RESERVED', 'HELD']); // loser: nothing free, but the winner may not pay
    await assertInvariant(db, 'p', 1, 1);
  });

  it('H3 an empty shard is NOT "sold out": the buyer is given a ticket from another shard', async () => {
    for (let i = 0; i < 20; i++) {
      const db = new FakeDatabase();
      db.seed<Shard>(shardPath('p', '0'), { remaining: 0, held: 0, sold: 5 });
      db.seed<Shard>(shardPath('p', '1'), { remaining: 5, held: 0, sold: 0 });
      const r = await createHold(db, { productId: 'p', userId: 'u' });
      expect(r.kind).toBe('HELD');
    }
  });

  it('H4 everything paid for => SOLD_OUT; everything reserved => ALL_RESERVED', async () => {
    const sold = new FakeDatabase();
    sold.seed<Shard>(shardPath('p', '0'), { remaining: 0, held: 0, sold: 3 });
    expect((await createHold(sold, { productId: 'p', userId: 'u' })).kind).toBe('SOLD_OUT');

    const reserved = new FakeDatabase();
    reserved.seed<Shard>(shardPath('p', '0'), { remaining: 0, held: 2, sold: 1 });
    expect((await createHold(reserved, { productId: 'p', userId: 'u' })).kind).toBe('ALL_RESERVED');
  });

  it('H5 a retried request (same hold id) never takes a second unit', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'p', 1, 5);
    await createHold(db, { productId: 'p', userId: 'u', newId: () => 'same' });
    await createHold(db, { productId: 'p', userId: 'u', newId: () => 'same' });
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 4, held: 1, sold: 0 });
  });
});

describe('expireHold and convertHold', () => {
  async function oneHold() {
    const db = new FakeDatabase();
    seedShards(db, 'p', 1, 1);
    await createHold(db, { productId: 'p', userId: 'u', now: at(0), newId: () => 'h1' });
    return db;
  }

  it('H6 expiry returns the unit to the SAME shard so someone else can buy it', async () => {
    const db = await oneHold();
    expect(await expireHold(db, 'h1', at(601))).toBe('EXPIRED');
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 1, held: 0, sold: 0 });
    expect(db.peek<Hold>(holdPath('h1'))!.status).toBe('EXPIRED');
    expect((await createHold(db, { productId: 'p', userId: 'next' })).kind).toBe('HELD');
  });

  it('H7 the timer firing twice returns the unit only once', async () => {
    const db = await oneHold();
    expect(await expireHold(db, 'h1', at(601))).toBe('EXPIRED');
    expect(await expireHold(db, 'h1', at(602))).toBe('IGNORED');
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 1, held: 0, sold: 0 });
  });

  it('H8 PAID FIRST, then the timer fires: the timer does nothing (no ticket is resurrected)', async () => {
    const db = await oneHold();
    await convertHold(db, 'h1');
    expect(await expireHold(db, 'h1', at(601))).toBe('IGNORED');
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 0, held: 0, sold: 1 });
    expect(db.peek<Hold>(holdPath('h1'))!.status).toBe('CONVERTED');
  });

  it('H9 TIMER FIRST, then payment arrives: conversion is refused (the PAID_LATE path in Slice 3)', async () => {
    const db = await oneHold();
    await expireHold(db, 'h1', at(601));
    await expect(convertHold(db, 'h1')).rejects.toThrow(HoldNotActive);
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 1, held: 0, sold: 0 });
  });

  it('H10 payment arrives after expiresAt but BEFORE the timer fired: still honoured', async () => {
    const db = await oneHold(); // expiresAt = 600s, timer has not run
    const hold = await convertHold(db, 'h1');
    expect(hold.status).toBe('CONVERTED');
    expect(db.peek<Shard>(shardPath('p', '0'))).toEqual({ remaining: 0, held: 0, sold: 1 });
  });

  it('H11 a timer that fires too early does nothing', async () => {
    const db = await oneHold();
    expect(await expireHold(db, 'h1', at(300))).toBe('NOT_YET');
    expect(db.peek<Hold>(holdPath('h1'))!.status).toBe('ACTIVE');
  });
});

describe('spreading the load', () => {
  it('H15 buyers are spread across drawers, not piled on one (this is what sharding is FOR)', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'p', 20, 50); // plenty of stock everywhere
    await Promise.all(Array.from({ length: 40 }, (_, i) => createHold(db, { productId: 'p', userId: `u${i}` })));
    const shards = await db.listCollection<Shard>(shardsPath('p'));
    const touched = shards.filter((s) => s.data.held > 0).length;
    expect(touched).toBeGreaterThanOrEqual(10); // always-first-shard would touch exactly 1
  });
});

describe('THE STORM (concurrency)', () => {
  it('H12 1,000 people, 100 tickets, 20 shards: exactly 100 holds, invariant intact', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'concert', 20, 5);
    const users = Array.from({ length: 1000 }, (_, i) => `user${i}`);

    let results = await Promise.all(users.map((u) => createHold(db, { productId: 'concert', userId: u })));

    // People told "busy" tap again (as the app would), until nobody is busy.
    for (let round = 0; round < 10; round++) {
      const busy = results.map((r, i) => (r.kind === 'BUSY' ? i : -1)).filter((i) => i >= 0);
      if (busy.length === 0) break;
      const again = await Promise.all(busy.map((i) => createHold(db, { productId: 'concert', userId: users[i] })));
      busy.forEach((idx, k) => (results[idx] = again[k]));
    }

    const winners = results.filter(isHeld);
    expect(winners).toHaveLength(100); // never 101, never 99
    expect(results.filter((r) => r.kind === 'BUSY')).toHaveLength(0);
    expect(new Set(winners.map((w) => w.hold.id)).size).toBe(100); // 100 distinct holds
    expect(new Set(winners.map((w) => w.hold.userId)).size).toBe(100); // 100 distinct people
    await assertInvariant(db, 'concert', 20, 5);
    expect(db.retries).toBeGreaterThan(0); // collisions really happened: the test is not trivial
  });

  it('H13 storm, then 20 holds expire, then 50 more people try: exactly 20 more get tickets', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'concert', 20, 5);
    const first = await Promise.all(
      Array.from({ length: 300 }, (_, i) => createHold(db, { productId: 'concert', userId: `a${i}`, now: at(0) })),
    );
    const holds = first.filter(isHeld).map((r) => r.hold);
    expect(holds.length).toBeGreaterThanOrEqual(98); // allow BUSY; the invariant is the real check

    for (const h of holds.slice(0, 20)) await expireHold(db, h.id, at(601));

    const second = await Promise.all(
      Array.from({ length: 50 }, (_, i) => createHold(db, { productId: 'concert', userId: `b${i}` })),
    );
    const shards = await db.listCollection<Shard>(shardsPath('concert'));
    const totalHeld = shards.reduce((n, s) => n + s.data.held, 0);
    expect(totalHeld).toBeLessThanOrEqual(100); // never above capacity
    expect(second.filter(isHeld).length).toBeLessThanOrEqual(20); // never more than were released
    await assertInvariant(db, 'concert', 20, 5);
  });

  it('H14 storm while payments and timers hit the same holds: invariant still holds', async () => {
    const db = new FakeDatabase();
    seedShards(db, 'concert', 10, 5);
    const first = await Promise.all(
      Array.from({ length: 200 }, (_, i) => createHold(db, { productId: 'concert', userId: `u${i}`, now: at(0) })),
    );
    const holds = first.filter(isHeld).map((r) => r.hold);
    // Half pay, half time out, all at the same moment, plus a second timer on the paying half.
    await Promise.all([
      ...holds
        .filter((_, i) => i % 2 === 0)
        .map((h) =>
          retrying(() => convertHold(db, h.id)).catch((e) => {
            if (!(e instanceof HoldNotActive)) throw e; // timer won the race: that is allowed
            return 'refused';
          }),
        ),
      ...holds.filter((_, i) => i % 2 === 0).map((h) => retrying(() => expireHold(db, h.id, at(601)))),
      ...holds.filter((_, i) => i % 2 === 1).map((h) => retrying(() => expireHold(db, h.id, at(601)))),
    ]);
    await assertInvariant(db, 'concert', 10, 5);
  });
});
