import { describe, expect, it } from 'vitest';
import {
  DeliveryError,
  type DeliveryErrorFacts,
} from '../../delivery/adapters/errors/deliveryError';
import { redactedError } from '../../delivery/adapters/errors/redact';
import { isTransientDeliveryError } from './transientError';

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
