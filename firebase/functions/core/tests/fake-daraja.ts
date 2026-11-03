// fake-daraja.ts
// A pretend M-Pesa for tests and the version 1 demo. It never moves real money.
// Tests drive it: choose how pushes behave, set what a status query says, build callback bodies.

import { Daraja, DarajaRejected, StatusQueryResult, StkPushRequest, StkPushResponse } from './daraja';

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeDaraja implements Daraja {
  pushes: StkPushRequest[] = [];
  statuses = new Map<string, StatusQueryResult>(); // what queryStatus answers, per attempt
  failNextPush: 'REJECT' | 'NETWORK' | null = null;
  private counter = 0;

  async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
    await pause();
    if (this.failNextPush) {
      const mode = this.failNextPush;
      this.failNextPush = null;
      throw mode === 'REJECT' ? new DarajaRejected('Daraja rejected the request') : new Error('network timeout');
    }
    this.pushes.push(req);
    this.counter++;
    return { checkoutRequestId: `ws_CO_${this.counter}` };
  }

  async queryStatus(checkoutRequestId: string): Promise<StatusQueryResult> {
    await pause();
    return this.statuses.get(checkoutRequestId) ?? { kind: 'PENDING' };
  }

  // The real Daraja success callback shape.
  successBody(checkoutRequestId: string, amountShillings: number, receipt = 'QGH12345AB', phone = '254712345678') {
    return {
      Body: {
        stkCallback: {
          MerchantRequestID: 'merchant-1',
          CheckoutRequestID: checkoutRequestId,
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: amountShillings },
              { Name: 'MpesaReceiptNumber', Value: receipt },
              { Name: 'TransactionDate', Value: 20261017180000 },
              { Name: 'PhoneNumber', Value: Number(phone) },
            ],
          },
        },
      },
    };
  }

  // The real failure shape: no metadata. 1032 = the customer cancelled the prompt.
  failureBody(checkoutRequestId: string, resultCode = 1032) {
    return {
      Body: {
        stkCallback: {
          MerchantRequestID: 'merchant-1',
          CheckoutRequestID: checkoutRequestId,
          ResultCode: resultCode,
          ResultDesc: 'Request cancelled by user',
        },
      },
    };
  }
}
