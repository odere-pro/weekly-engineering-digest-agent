import { describe, expect, it, vi, type Mock } from 'vitest';
import { DeliveryError, type DeliveryErrorFacts } from '../delivery/adapters/errors/deliveryError';
import { withDeliveryRetry } from './retryingDelivery';
import type { Delivery, DigestMessage, FailureNote } from '../delivery/Delivery';
import type { Logger } from '../shared/telemetry';

const MESSAGE: DigestMessage = { weekId: '2026-W42', subject: 'Digest', markdown: '# Digest' };
const NOTE: FailureNote = { weekId: '2026-W42', step: 'deliver', message: 'it broke' };

interface MockLogger extends Logger {
  warn: Mock<Logger['warn']>;
}

function mockLogger(): MockLogger {
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface FlakyDelivery extends Delivery {
  sendDigest: Mock<Delivery['sendDigest']>;
  sendFailure: Mock<Delivery['sendFailure']>;
}

function flaky(id: Delivery['id'] = 'slack'): FlakyDelivery {
  return {
    id,
    sendDigest: vi.fn<Delivery['sendDigest']>(() => Promise.resolve()),
    sendFailure: vi.fn<Delivery['sendFailure']>(() => Promise.resolve()),
  };
}

function retrying(inner: Delivery, options: { retries?: number } = {}) {
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  const logger = mockLogger();
  return { delivery: withDeliveryRetry(inner, { logger, sleep, ...options }), sleep, logger };
}

/** A delivery error as the adapters throw it: only the typed facts, no helpful text. */
function failed(facts: DeliveryErrorFacts, message = 'Delivery failed'): DeliveryError {
  return new DeliveryError(message, facts);
}

describe('withDeliveryRetry', () => {
  it('keeps the id of the delivery it wraps', () => {
    expect(retrying(flaky('email')).delivery.id).toBe('email');
  });

  it('sends once when the first try works', async () => {
    const inner = flaky();
    const { delivery, sleep, logger } = retrying(inner);

    await delivery.sendDigest(MESSAGE);

    expect(inner.sendDigest).toHaveBeenCalledExactlyOnceWith(MESSAGE);
    expect(sleep).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('tries a transient failure again, with the same message', async () => {
    const inner = flaky();
    inner.sendDigest.mockRejectedValueOnce(
      failed({ status: 503 }, 'Slack webhook answered HTTP 503'),
    );
    const { delivery, logger } = retrying(inner);

    await delivery.sendDigest(MESSAGE);

    expect(inner.sendDigest).toHaveBeenCalledTimes(2);
    expect(inner.sendDigest).toHaveBeenLastCalledWith(MESSAGE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({
        delivery: 'slack',
        operation: 'sendDigest',
        retry: 1,
        ofMax: 2,
        error: 'Slack webhook answered HTTP 503',
      }),
    );
  });

  it('retries twice with a growing wait, then throws the last error', async () => {
    const inner = flaky('email');
    inner.sendDigest.mockRejectedValue(
      failed(
        { code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' },
        'SMTP delivery failed: Connection timeout',
      ),
    );
    const { delivery, sleep } = retrying(inner);

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('Connection timeout');

    expect(inner.sendDigest).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 10_000]);
  });

  it('does not retry a failure that cannot be a blip', async () => {
    const inner = flaky();
    inner.sendDigest.mockRejectedValue(failed({ status: 404 }, 'Slack webhook answered HTTP 404'));
    const { delivery, sleep } = retrying(inner);

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('HTTP 404');

    expect(inner.sendDigest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a failure note the same way', async () => {
    const inner = flaky();
    inner.sendFailure.mockRejectedValueOnce(failed({ code: 'ECONNREFUSED' }, 'fetch failed'));
    const { delivery, logger } = retrying(inner);

    await delivery.sendFailure(NOTE);

    expect(inner.sendFailure).toHaveBeenCalledTimes(2);
    expect(inner.sendFailure).toHaveBeenLastCalledWith(NOTE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({ operation: 'sendFailure' }),
    );
  });

  it('logs the typed facts of the error it retries, not only its text', async () => {
    const inner = flaky('email');
    inner.sendDigest.mockRejectedValueOnce(
      failed({ code: 'EMESSAGE', responseCode: 451 }, 'SMTP delivery failed: Message failed'),
    );
    const { delivery, logger } = retrying(inner);

    await delivery.sendDigest(MESSAGE);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({ code: 'EMESSAGE', responseCode: 451, status: undefined }),
    );
  });

  it.each([
    ['a reset connection', { code: 'ECONNRESET' }],
    ['a socket timeout after the body', { code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT' }],
    ['a request timeout', {}],
  ])('sends once and throws on %s: the message may already be out', async (_name, facts) => {
    const inner = flaky('email');
    inner.sendDigest.mockRejectedValue(failed(facts, 'it dropped'));
    inner.sendFailure.mockRejectedValue(failed(facts, 'it dropped'));
    const { delivery, sleep } = retrying(inner);

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('it dropped');
    await expect(delivery.sendFailure(NOTE)).rejects.toThrow('it dropped');

    expect(inner.sendDigest).toHaveBeenCalledTimes(1);
    expect(inner.sendFailure).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the error as the adapter made it, facts and cause included', async () => {
    const inner = flaky();
    const cause = failed({ code: 'ECONNREFUSED' }, 'inner');
    const error = new DeliveryError('Slack webhook answered HTTP 404', { status: 404, cause });
    inner.sendDigest.mockRejectedValue(error);
    const { delivery } = retrying(inner);

    await expect(delivery.sendDigest(MESSAGE)).rejects.toBe(error);
  });

  it('takes the retry count from the options', async () => {
    const inner = flaky();
    inner.sendDigest.mockRejectedValue(failed({ code: 'ECONNREFUSED' }, 'fetch failed'));
    const { delivery } = retrying(inner, { retries: 0 });

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('fetch failed');

    expect(inner.sendDigest).toHaveBeenCalledTimes(1);
  });

  it('waits for real when no sleep is injected', async () => {
    vi.useFakeTimers();
    try {
      const inner = flaky();
      inner.sendDigest.mockRejectedValueOnce(failed({ code: 'ECONNREFUSED' }, 'fetch failed'));
      const delivery = withDeliveryRetry(inner, { logger: mockLogger() });

      const sending = delivery.sendDigest(MESSAGE);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(inner.sendDigest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await sending;

      expect(inner.sendDigest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withDeliveryRetry wraps every member of the channel', () => {
  // A member added to `Delivery` is a type error here until it has a check: say how it is wrapped.
  const MEMBERS: Record<
    keyof Delivery,
    (wrapped: Delivery, inner: FlakyDelivery) => Promise<void>
  > = {
    id: (wrapped) => {
      expect(wrapped.id).toBe('email');
      return Promise.resolve();
    },
    sendDigest: async (wrapped, inner) => {
      inner.sendDigest.mockRejectedValueOnce(failed({ status: 503 }));

      await wrapped.sendDigest(MESSAGE);

      expect(inner.sendDigest).toHaveBeenCalledTimes(2);
      expect(inner.sendDigest).toHaveBeenLastCalledWith(MESSAGE);
    },
    sendFailure: async (wrapped, inner) => {
      inner.sendFailure.mockRejectedValueOnce(failed({ code: 'ECONNREFUSED' }));

      await wrapped.sendFailure(NOTE);

      expect(inner.sendFailure).toHaveBeenCalledTimes(2);
      expect(inner.sendFailure).toHaveBeenLastCalledWith(NOTE);
    },
  };

  it.each(Object.keys(MEMBERS) as (keyof Delivery)[])('%s is wrapped', async (member) => {
    const inner = flaky('email');

    await MEMBERS[member](retrying(inner).delivery, inner);
  });

  it('wraps nothing else: the channel has exactly the members of the port', () => {
    const { delivery } = retrying(flaky());

    expect(Object.keys(delivery).sort()).toEqual(Object.keys(MEMBERS).sort());
  });
});
