// order-store.ts
// The shape of an order in the database, and the bridge between transitionOrder
// (which wants an OrderStore) and a database transaction.
//
// KEY RULE: an order has the SAME id as the hold that reserved its stock (1 hold : 1 order).
// So anyone holding a hold id can find its order with no query.

import { Transaction } from './database';
import { Order, OrderStore } from './transition-order';

export interface PaymentOrder extends Order {
  userId: string;
  holdId: string; // == id
  productId: string;
  amount: number; // minor units (cents), copied from the product price ON THE SERVER
  paymentId?: string; // the CheckoutRequestID of the latest payment attempt
}

export const orderPath = (orderId: string) => `orders/${orderId}`;

// Firestore needs all READS before any WRITES in one transaction. transitionOrder normally
// reads the order itself, which would break that rule if we had already written something.
// So the caller reads the order up front, and this store hands that same copy back.
export class PreloadedOrderStore implements OrderStore {
  constructor(
    private readonly order: PaymentOrder,
    private readonly tx: Transaction,
  ) {}
  async get(orderId: string): Promise<Order | null> {
    return orderId === this.order.id ? structuredClone(this.order) : null;
  }
  async save(order: Order): Promise<void> {
    this.tx.set(orderPath(order.id), order); // buffered until the transaction commits
  }
}
