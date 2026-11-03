// daraja.ts
// What we need from M-Pesa Daraja, as an interface. Production implements it with real HTTPS
// calls (later, version 2); tests and the version 1 demo use fake-daraja.ts. The business
// logic cannot tell the difference.

export class DarajaRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DarajaRejected';
  }
}

export interface StkPushRequest {
  phone: string; // 2547XXXXXXXX or 2541XXXXXXXX
  amountShillings: number; // whole shillings: STK Push does not take cents
  reference: string; // our order id
}

export interface StkPushResponse {
  checkoutRequestId: string; // Daraja's id for this attempt; becomes our payment document id
}

export type StatusQueryResult =
  | { kind: 'SUCCESS' }
  | { kind: 'FAILED'; resultCode: number }
  | { kind: 'PENDING' }; // still being processed, or we cannot tell yet

export interface Daraja {
  stkPush(req: StkPushRequest): Promise<StkPushResponse>;
  queryStatus(checkoutRequestId: string): Promise<StatusQueryResult>;
}

// What we keep from a callback after reading it.
export interface CallbackResult {
  checkoutRequestId: string;
  resultCode: number; // 0 = paid. 1032 cancelled, 1037 timed out, 2001 wrong PIN, 1 insufficient funds
  receipt?: string;
  amount?: number; // MINOR units (cents), converted from the shillings in the callback
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// Reads the real Daraja callback shape. Returns null for anything we do not recognise:
// the caller still stores the raw body and answers 200.
export function parseCallback(body: unknown): CallbackResult | null {
  if (!isRecord(body) || !isRecord(body.Body) || !isRecord(body.Body.stkCallback)) return null;
  const cb = body.Body.stkCallback;
  if (typeof cb.CheckoutRequestID !== 'string' || cb.CheckoutRequestID === '') return null;
  const resultCode = Number(cb.ResultCode);
  if (!Number.isInteger(resultCode)) return null;

  const result: CallbackResult = { checkoutRequestId: cb.CheckoutRequestID, resultCode };
  const meta = isRecord(cb.CallbackMetadata) ? cb.CallbackMetadata.Item : undefined;
  if (Array.isArray(meta)) {
    const value = (name: string) => meta.find((i) => isRecord(i) && i.Name === name);
    const receipt = value('MpesaReceiptNumber');
    if (isRecord(receipt) && typeof receipt.Value === 'string') result.receipt = receipt.Value;
    const amount = value('Amount');
    if (isRecord(amount) && typeof amount.Value === 'number') result.amount = Math.round(amount.Value * 100);
  }
  return result;
}

// 0712 345 678, +254712345678, 254712345678, 712345678 -> 254712345678. Otherwise null.
export function normalizePhone(input: string): string | null {
  let p = input.replace(/[\s-]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}
