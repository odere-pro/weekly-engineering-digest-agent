import { describe, expect, it } from 'vitest';
import { redactedError, redactSecrets } from '../../../src/adapters/delivery/redact.js';

describe('redactSecrets', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redactSecrets('a SECRET b SECRET c TOKEN', ['SECRET', 'TOKEN'])).toBe(
      'a [redacted] b [redacted] c [redacted]',
    );
  });

  it('removes the longer secret whole when one contains the other', () => {
    expect(redactSecrets('see https://h.test/ now', ['https://h.test', 'https://h.test/'])).toBe(
      'see [redacted] now',
    );
  });

  it('ignores empty secrets instead of mangling the text', () => {
    expect(redactSecrets('plain text', ['', 'absent'])).toBe('plain text');
  });
});

describe('redactedError', () => {
  it('builds a prefixed error with the secrets removed and no cause', () => {
    const error = redactedError('Delivery failed', new Error('bad password hunter2'), ['hunter2']);

    expect(error.message).toBe('Delivery failed: bad password [redacted]');
    expect(error.cause).toBeUndefined();
  });

  it('accepts a thrown value that is not an Error', () => {
    expect(redactedError('Delivery failed', 'timeout', []).message).toBe(
      'Delivery failed: timeout',
    );
  });
});
