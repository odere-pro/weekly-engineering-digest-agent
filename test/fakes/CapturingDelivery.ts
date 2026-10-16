import type { Delivery, DigestMessage, FailureNote } from '../../src/ports/Delivery.js';

/** Records what would have been sent. Set `failWith` to simulate a delivery error. */
export class CapturingDelivery implements Delivery {
  readonly digests: DigestMessage[] = [];
  readonly failures: FailureNote[] = [];
  failWith: Error | undefined;

  constructor(readonly id: Delivery['id'] = 'markdown') {}

  sendDigest(message: DigestMessage): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.digests.push(message);
    return Promise.resolve();
  }

  sendFailure(note: FailureNote): Promise<void> {
    this.failures.push(note);
    return Promise.resolve();
  }
}
