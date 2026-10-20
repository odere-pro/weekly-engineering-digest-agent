import { DeliveryError, statedFacts } from './deliveryError';

/** What the mail server refused: how many recipients, and the SMTP reply codes it gave. */
interface Refusal {
  readonly count: number;
  readonly replyCodes: readonly number[];
}

/**
 * Reads the answer of a send that did not throw. nodemailer throws only when every recipient is
 * refused; with some accepted it resolves with `{ accepted, rejected, rejectedErrors }`. Anything
 * that is not that shape (another transport, a bare `{}`) refused nobody.
 */
function refusalIn(result: unknown): Refusal | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const { rejected, rejectedErrors } = result as Readonly<Record<string, unknown>>;
  if (!Array.isArray(rejected) || rejected.length === 0) return undefined;
  const replies: unknown[] = Array.isArray(rejectedErrors) ? rejectedErrors : [];
  const codes = replies.map((reply) => statedFacts(reply).responseCode);
  const replyCodes = [...new Set(codes)].filter((code): code is number => code !== undefined);
  return { count: rejected.length, replyCodes };
}

/**
 * The error for a mail the server took for only some of its recipients, or nothing when it took
 * it for all of them. The text is a count and integer reply codes: never the server's own words or
 * an address, which can echo a secret.
 *
 * It carries no retry fact, on purpose. A `responseCode` of 450 would make the retry wrapper send
 * again, and that would give a second copy to the recipients who already have the first. The
 * channel fails; the failure note goes out and a resume sends the week again.
 */
export function refusedRecipientsError(
  result: unknown,
  recipientCount: number,
): DeliveryError | undefined {
  const refusal = refusalIn(result);
  if (refusal === undefined) return undefined;
  const { count, replyCodes } = refusal;
  const replies = replyCodes.length > 0 ? ` (SMTP ${replyCodes.join(', ')})` : '';
  const others = count < recipientCount ? '; the rest accepted the mail' : '';
  return new DeliveryError(
    `SMTP delivery incomplete: ${String(count)} of ${String(recipientCount)} recipients refused${replies}${others}`,
  );
}
