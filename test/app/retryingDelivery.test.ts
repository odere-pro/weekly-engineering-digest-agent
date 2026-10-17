import { describe, expect, it, vi, type Mock } from 'vitest';
import { isTransientDeliveryError, withDeliveryRetry } from '../../src/app/retryingDelivery.js';
import type { Delivery, DigestMessage, FailureNote } from '../../src/ports/Delivery.js';
import type { Logger } from '../../src/shared/telemetry.js';

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

describe('isTransientDeliveryError', () => {
  it.each([
    ['a Slack 5xx', 'Slack webhook answered HTTP 503'],
    ['a Slack gateway error', 'Slack webhook answered HTTP 502'],
    ['a refused connection', 'Slack webhook request failed: fetch failed'],
    ['a reset connection', 'SMTP delivery failed: read ECONNRESET'],
    ['a refused SMTP port', 'SMTP delivery failed: connect ECONNREFUSED 127.0.0.1:587'],
    [
      'a name that did not resolve',
      'SMTP delivery failed: getaddrinfo ENOTFOUND smtp.example.test',
    ],
    ['a temporary DNS failure', 'SMTP delivery failed: getaddrinfo EAI_AGAIN smtp.example.test'],
    ['an unreachable host', 'SMTP delivery failed: connect EHOSTUNREACH 10.0.0.9:587'],
    ['an undici socket error', 'Slack webhook request failed: UND_ERR_SOCKET'],
    ['a fetch timeout', 'Slack webhook request failed: The operation was aborted due to timeout'],
    ['an SMTP connection timeout', 'SMTP delivery failed: Connection timeout'],
    ['an SMTP greeting timeout', 'SMTP delivery failed: Greeting never received'],
    ['a socket timeout', 'SMTP delivery failed: Socket timeout'],
    ['a connect timeout', 'SMTP delivery failed: connect timed out'],
    ['a socket hang up', 'Slack webhook request failed: socket hang up'],
    ['a closed connection', 'SMTP delivery failed: Connection closed unexpectedly'],
    ['a dropped TLS handshake', 'SMTP delivery failed: Client network socket disconnected'],
    ['an SMTP 4yz reply (try again later)', 'SMTP delivery failed: Mail command failed: 451 4.3.0'],
    ['an SMTP 4yz reply to the message', 'SMTP delivery failed: Message failed: 421 Try later'],
    [
      'a greylisted recipient (4yz)',
      "SMTP delivery failed: Can't send mail - all recipients were rejected: 450 4.2.0 Greylisted",
    ],
    [
      'a temporary login failure (4yz)',
      'SMTP delivery failed: Invalid login: 454 4.7.0 Temporary authentication failure',
    ],
    [
      'one recipient deferred (4yz)',
      'SMTP delivery failed: Message failed for recipient a@b.test: 452 4.2.2 Mailbox full',
    ],
    ['a connection error with no reason', 'SMTP delivery failed: '],
    ['a request error with no reason', 'Slack webhook request failed:'],
  ])('retries %s', (_name, message) => {
    expect(isTransientDeliveryError(new Error(message))).toBe(true);
  });

  it.each([
    ['a Slack 4xx', 'Slack webhook answered HTTP 404'],
    ['a Slack rate limit', 'Slack webhook answered HTTP 429'],
    ['a bad Slack URL', 'Slack webhook URL must use https'],
    ['a refused login', 'SMTP delivery failed: Invalid login: 535 5.7.8 Bad credentials'],
    [
      'an SMTP 5yz reply (permanent)',
      'SMTP delivery failed: Mail command failed: 550 No such user',
    ],
    [
      'all recipients rejected',
      "SMTP delivery failed: Can't send mail - all recipients were rejected",
    ],
    [
      'a permanent reply that says timeout',
      'SMTP delivery failed: Message failed: 554 5.7.1 Rejected, timeout exceeded',
    ],
    [
      'a permanent login failure that says timed out',
      'SMTP delivery failed: Invalid login: 535 5.7.8 Session timed out',
    ],
    ['a path that says timeout', "ENOENT: no such file or directory, open '/data/timeout/a.md'"],
    ['a port in a failure', 'SMTP delivery failed: Unsupported option on port :587'],
    ['a missing folder permission', "EACCES: permission denied, open '/out/2026-W42.md'"],
    ['a full disk', 'ENOSPC: no space left on device, write'],
    ['an invalid week id', 'Cannot deliver to a file: invalid week id "x"'],
    ['an HTTP number that is not a status', 'Slack webhook sent 5000 bytes'],
  ])('does not retry %s', (_name, message) => {
    expect(isTransientDeliveryError(new Error(message))).toBe(false);
  });

  it('reads the message of anything thrown', () => {
    expect(isTransientDeliveryError('Slack webhook answered HTTP 500')).toBe(true);
    expect(isTransientDeliveryError({ code: 'ECONNRESET' })).toBe(false);
    expect(isTransientDeliveryError(undefined)).toBe(false);
  });
});

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
    inner.sendDigest.mockRejectedValueOnce(new Error('Slack webhook answered HTTP 503'));
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
    inner.sendDigest.mockRejectedValue(new Error('SMTP delivery failed: Connection timeout'));
    const { delivery, sleep } = retrying(inner);

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('Connection timeout');

    expect(inner.sendDigest).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 10_000]);
  });

  it('does not retry a failure that cannot be a blip', async () => {
    const inner = flaky();
    inner.sendDigest.mockRejectedValue(new Error('Slack webhook answered HTTP 404'));
    const { delivery, sleep } = retrying(inner);

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('HTTP 404');

    expect(inner.sendDigest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a failure note the same way', async () => {
    const inner = flaky();
    inner.sendFailure.mockRejectedValueOnce(new Error('fetch failed'));
    const { delivery, logger } = retrying(inner);

    await delivery.sendFailure(NOTE);

    expect(inner.sendFailure).toHaveBeenCalledTimes(2);
    expect(inner.sendFailure).toHaveBeenLastCalledWith(NOTE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({ operation: 'sendFailure' }),
    );
  });

  it('takes the retry count from the options', async () => {
    const inner = flaky();
    inner.sendDigest.mockRejectedValue(new Error('fetch failed'));
    const { delivery } = retrying(inner, { retries: 0 });

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow('fetch failed');

    expect(inner.sendDigest).toHaveBeenCalledTimes(1);
  });

  it('waits for real when no sleep is injected', async () => {
    vi.useFakeTimers();
    try {
      const inner = flaky();
      inner.sendDigest.mockRejectedValueOnce(new Error('fetch failed'));
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
