import { deliveryFacts } from '../../delivery/adapters/errors/deliveryError';

/**
 * Failures that happen while connecting, before the first byte of the message is written: the
 * channel cannot have the message, so sending again cannot double it. nodemailer's own codes
 * (`EDNS`) and the system codes it keeps under them (`originalCode`) are both read.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EDNS',
  'UND_ERR_CONNECT_TIMEOUT',
]);
/** nodemailer's timeouts that hit before MAIL FROM. A `SOCKET_TIMEOUT` can come after the body. */
const CONNECT_PHASE_TIMEOUTS: ReadonlySet<string> = new Set([
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
]);
/**
 * SMTP replies that say the server did not take the message and may be asked again: 421 (service
 * closing), 450 (mailbox busy), 451 (local error). An answer arrived, so nothing was accepted.
 */
const TRANSIENT_SMTP_REPLIES: ReadonlySet<number> = new Set([421, 450, 451]);
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FROM = 500;
const HTTP_SERVER_ERROR_TO = 599;

/**
 * True when sending the same message again cannot put a second copy in the channel: the failure
 * came before the message was written (connecting), or the server answered that it did not take
 * it (HTTP 429 or 5xx, SMTP 421, 450 or 451). Decided by the typed facts of the error (see
 * `DeliveryError`), never by its message. A reset or a timeout after the body went out is not
 * retried, because the channel may already have the message.
 */
export function isTransientDeliveryError(error: unknown): boolean {
  const { status, responseCode, code, originalCode, timeoutType } = deliveryFacts(error);
  if (status !== undefined) return isRetryableHttpStatus(status);
  if (responseCode !== undefined) return TRANSIENT_SMTP_REPLIES.has(responseCode);
  if (timeoutType !== undefined) return CONNECT_PHASE_TIMEOUTS.has(timeoutType);
  return [code, originalCode].some((each) => each !== undefined && CONNECT_PHASE_CODES.has(each));
}

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    (status >= HTTP_SERVER_ERROR_FROM && status <= HTTP_SERVER_ERROR_TO)
  );
}
