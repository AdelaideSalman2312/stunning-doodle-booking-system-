// transition-order.ts
// The ONLY function allowed to change an order's status.
// It is pure logic: storage is injected, so it is tested in milliseconds.
//
// IMPORTANT: this file guarantees the RULES (legal paths, stale-state check,
// history). The guarantee that two simultaneous callers cannot both succeed comes
// from the OrderStore implementation: in production, get() and save() must run
// inside ONE Firestore transaction (built in Slice 3).

import { OrderStatus, isAllowed } from './order-states';

export interface HistoryEntry {
  from: OrderStatus;
  to: OrderStatus;
  at: string; // ISO timestamp, from the SERVER clock, never the phone
  by: string; // which function or admin made the change
}

export interface Order {
  id: string;
  status: OrderStatus;
  history: HistoryEntry[];
}

export interface OrderStore {
  get(orderId: string): Promise<Order | null>;
  save(order: Order): Promise<void>;
}

export class OrderNotFound extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'OrderNotFound';
  }
}

// Someone else moved the order since the caller last looked (check-then-act race).
export class StaleState extends Error {
  constructor(orderId: string, expected: OrderStatus, actual: OrderStatus) {
    super(`Order ${orderId} is ${actual}, caller expected ${expected}`);
    this.name = 'StaleState';
  }
}

// The path is not in the allowed-transitions map.
export class IllegalTransition extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Transition ${from} -> ${to} is not allowed`);
    this.name = 'IllegalTransition';
  }
}

export async function transitionOrder(
  store: OrderStore,
  orderId: string,
  expectedFrom: OrderStatus,
  to: OrderStatus,
  by: string,
  now: () => Date = () => new Date(), // injectable so tests control time
): Promise<Order> {
  const order = await store.get(orderId);
  if (order === null) throw new OrderNotFound(orderId);

  // Check 1: has someone else already moved it? (the race protection)
  if (order.status !== expectedFrom) {
    throw new StaleState(orderId, expectedFrom, order.status);
  }

  // Check 2: is this path legal at all? (the state machine)
  if (!isAllowed(expectedFrom, to)) {
    throw new IllegalTransition(expectedFrom, to);
  }

  // Only now do we build the new order. We never mutate the loaded one:
  // a half-changed object must not exist if a later step throws.
  const updated: Order = {
    ...order,
    status: to,
    history: [...order.history, { from: expectedFrom, to, at: now().toISOString(), by }],
  };

  await store.save(updated); // the single write
  return updated;
}
