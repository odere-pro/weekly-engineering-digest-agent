import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  DeliveryError,
  type DeliveryErrorFacts,
} from '../../src/adapters/delivery/deliveryError.js';
import { redactedError } from '../../src/adapters/delivery/redact.js';
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

/** A delivery error as the adapters throw it: only the typed facts, no helpful text. */
function failed(facts: DeliveryErrorFacts, message = 'Delivery failed'): DeliveryError {
  return new DeliveryError(message, facts);
}

describe('isTransientDeliveryError', () => {
  it.each([
    ['a Slack rate limit', { status: 429 }],
    ['a Slack 500', { status: 500 }],
    ['a gateway error', { status: 502 }],
    ['a Slack 503', { status: 503 }],
    ['a gateway timeout', { status: 504 }],
    ['the last 5xx status', { status: 599 }],
    ['a refused connection', { code: 'ECONNREFUSED' }],
    ['a name that did not resolve', { code: 'ENOTFOUND' }],
    ['a temporary DNS failure', { code: 'EAI_AGAIN' }],
    ['an unreachable host', { code: 'EHOSTUNREACH' }],
    ['an unreachable network', { code: 'ENETUNREACH' }],
    ['an undici connect timeout', { code: 'UND_ERR_CONNECT_TIMEOUT' }],
    ['a refused SMTP connection', { code: 'ESOCKET', originalCode: 'ECONNREFUSED' }],
    ['an SMTP host that did not resolve', { code: 'EDNS', originalCode: 'ENOTFOUND' }],
    ['an SMTP DNS failure with no system code', { code: 'EDNS' }],
    ['an SMTP connect timeout', { code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' }],
    ['an SMTP greeting timeout', { code: 'ETIMEDOUT', timeoutType: 'GREETING_TIMEOUT' }],
    ['an SMTP TLS upgrade timeout', { code: 'ETIMEDOUT', timeoutType: 'UPGRADE_TIMEOUT' }],
    ['an SMTP 421 (service closing)', { code: 'ECONNECTION', responseCode: 421 }],
    ['an SMTP 450 (mailbox busy)', { code: 'EENVELOPE', responseCode: 450 }],
    ['an SMTP 451 (local error)', { code: 'EMESSAGE', responseCode: 451 }],
  ])('retries %s', (_name, facts) => {
    expect(isTransientDeliveryError(failed(facts))).toBe(true);
  });

  it.each([
    ['a reset connection (the body may have gone)', { code: 'ECONNRESET' }],
    ['a reset SMTP socket', { code: 'ESOCKET', originalCode: 'ECONNRESET' }],
    ['a broken pipe', { code: 'EPIPE' }],
    ['an aborted connection', { code: 'ECONNABORTED' }],
    ['an undici socket error', { code: 'UND_ERR_SOCKET' }],
    ['an undici headers timeout (the body was sent)', { code: 'UND_ERR_HEADERS_TIMEOUT' }],
    ['an undici body timeout', { code: 'UND_ERR_BODY_TIMEOUT' }],
    ['a timeout of unknown phase', { code: 'ETIMEDOUT' }],
    [
      'an SMTP socket timeout (after the body)',
      { code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT' },
    ],
    ['a closed SMTP connection', { code: 'ECONNECTION' }],
    ['an SMTP socket error', { code: 'ESOCKET' }],
    ['a TLS failure', { code: 'ETLS' }],
    ['a refused login (code only)', { code: 'EAUTH' }],
    ['a Slack 400', { status: 400 }],
    ['a Slack 403', { status: 403 }],
    ['a Slack 404', { status: 404 }],
    ['a Slack 410', { status: 410 }],
    ['a redirect', { status: 302 }],
    ['an HTTP 451 (legal), which is not an SMTP reply', { status: 451 }],
    ['the status just below 5xx', { status: 499 }],
    ['an SMTP 452 (storage full)', { code: 'EENVELOPE', responseCode: 452 }],
    ['an SMTP 454 (temporary auth failure)', { code: 'EAUTH', responseCode: 454 }],
    ['an SMTP 535 (bad login)', { code: 'EAUTH', responseCode: 535 }],
    ['an SMTP 550 (no such user)', { code: 'EENVELOPE', responseCode: 550 }],
    ['an SMTP 554', { code: 'EMESSAGE', responseCode: 554 }],
    ['an answer, whatever the code says', { status: 404, code: 'ECONNREFUSED' }],
    ['a reply, whatever the code says', { responseCode: 550, code: 'ECONNREFUSED' }],
    ['a folder that is not writable', { code: 'EACCES' }],
    ['a missing folder', { code: 'ENOENT' }],
    ['a full disk', { code: 'ENOSPC' }],
    ['an error with no facts', {}],
  ])('does not retry %s', (_name, facts) => {
    expect(isTransientDeliveryError(failed(facts))).toBe(false);
  });

  it('reads the code the way fetch reports it, on the cause', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED' });

    expect(isTransientDeliveryError(new TypeError('fetch failed', { cause }))).toBe(true);
  });

  it('reads a raw nodemailer error that no adapter wrapped', () => {
    const raw = Object.assign(new Error('Message failed: 451'), {
      code: 'EMESSAGE',
      responseCode: 451,
    });

    expect(isTransientDeliveryError(raw)).toBe(true);
  });

  it('does not read the message: only the typed facts decide', () => {
    expect(isTransientDeliveryError(new Error('Slack webhook answered HTTP 503'))).toBe(false);
    expect(isTransientDeliveryError(new Error('connect ECONNREFUSED 127.0.0.1:587'))).toBe(false);
    expect(isTransientDeliveryError(new Error('SMTP delivery failed: 451 4.3.0 Try later'))).toBe(
      false,
    );
    expect(isTransientDeliveryError(failed({ code: 'ECONNRESET' }, 'connect ECONNREFUSED'))).toBe(
      false,
    );
    expect(isTransientDeliveryError(failed({}, 'Slack webhook answered HTTP 429'))).toBe(false);
  });

  it('does not retry a timeout of the whole request, which may have sent the body', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    expect(isTransientDeliveryError(timeout)).toBe(false);
  });

  it('does not retry something thrown that is not an error', () => {
    expect(isTransientDeliveryError('Slack webhook answered HTTP 500')).toBe(false);
    expect(isTransientDeliveryError(undefined)).toBe(false);
    expect(isTransientDeliveryError(null)).toBe(false);
  });

  it('treats an error that went through redactedError as it treats the original', () => {
    const original = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
    });

    expect(isTransientDeliveryError(redactedError('SMTP delivery failed', original, []))).toBe(
      true,
    );
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
