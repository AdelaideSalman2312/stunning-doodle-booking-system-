// order-states.ts
// THE order state machine, as data. This map is the single source of truth:
// transitionOrder reads it, and the tests are generated from it.

export const ALL_STATES = [
  'CREATED',
  'AWAITING_PAYMENT',
  'PAYMENT_FAILED',
  'PAID',
  'FULFILLED',
  'EXPIRED',
  'PAID_LATE',
  'REFUND_PENDING',
  'REFUNDED',
] as const;

export type OrderStatus = (typeof ALL_STATES)[number];

export const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // CREATED -> FULFILLED is the free-order path (total is 0, no payment needed).
  // CREATED -> EXPIRED covers a hold timing out before the STK Push was ever sent.
  CREATED: ['AWAITING_PAYMENT', 'FULFILLED', 'EXPIRED'],
  AWAITING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'EXPIRED'],
  // Retry is allowed only while the hold is alive; the hold check lives in payments-initiate.
  PAYMENT_FAILED: ['AWAITING_PAYMENT', 'EXPIRED'],
  PAID: ['FULFILLED'],
  FULFILLED: ['REFUND_PENDING'],
  // EXPIRED has exactly one exit: money arrived anyway. It can NEVER reopen to AWAITING_PAYMENT.
  EXPIRED: ['PAID_LATE'],
  PAID_LATE: ['FULFILLED', 'REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED'],
  REFUNDED: [], // terminal
};

export function isAllowed(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export const TERMINAL_STATES: readonly OrderStatus[] = ALL_STATES.filter(
  (s) => ALLOWED_TRANSITIONS[s].length === 0,
);
