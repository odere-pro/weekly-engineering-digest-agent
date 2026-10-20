import { describe, expect, it } from 'vitest';
import { DeliveryError, deliveryFacts } from './deliveryError';
import { refusedRecipientsError } from './refusedRecipients';

/** What nodemailer resolves with for a recipient the server refused at RCPT TO. */
function refusal(address: string, responseCode: number, response: string): Error {
  return Object.assign(new Error('Recipient command failed'), {
    code: 'EENVELOPE',
    recipient: address,
    responseCode,
    response,
    command: 'RCPT TO',
  });
}

describe('refusedRecipientsError', () => {
  it.each([
    ['all recipients accepted', { accepted: ['a@x.io', 'b@x.io'], rejected: [] }],
    ['no rejected list at all', { accepted: ['a@x.io'] }],
    ['an empty answer', {}],
    ['an answer that is not an object', 'queued'],
    ['no answer', undefined],
    ['a null answer', null],
    ['a rejected value that is not a list', { rejected: 'b@x.io' }],
  ])('is nothing for %s', (_name, result) => {
    expect(refusedRecipientsError(result, 2)).toBeUndefined();
  });

  it('counts the refused recipients out of all of them and names the reply code', () => {
    const error = refusedRecipientsError(
      {
        accepted: ['good@x.io'],
        rejected: ['typo@x.io'],
        rejectedErrors: [refusal('typo@x.io', 550, '550 5.1.1 <typo@x.io> no such user')],
      },
      2,
    );

    expect(error).toBeInstanceOf(DeliveryError);
    expect(error?.message).toBe(
      'SMTP delivery incomplete: 1 of 2 recipients refused (SMTP 550); the rest accepted the mail',
    );
  });

  it('names each reply code once, in the order the server gave them', () => {
    const error = refusedRecipientsError(
      {
        rejected: ['a@x.io', 'b@x.io', 'c@x.io'],
        rejectedErrors: [
          refusal('a@x.io', 553, ''),
          refusal('b@x.io', 550, ''),
          refusal('c@x.io', 553, ''),
        ],
      },
      4,
    );

    expect(error?.message).toContain('3 of 4 recipients refused (SMTP 553, 550)');
  });

  it('leaves the code out when the answer gives none', () => {
    const error = refusedRecipientsError({ rejected: ['typo@x.io'] }, 2);

    expect(error?.message).toBe(
      'SMTP delivery incomplete: 1 of 2 recipients refused; the rest accepted the mail',
    );
  });

  it('skips a refusal whose code is not an integer', () => {
    const error = refusedRecipientsError(
      {
        rejected: ['a@x.io', 'b@x.io'],
        rejectedErrors: [
          Object.assign(new Error('x'), { responseCode: '550 hunter2' }),
          'not an error',
          null,
          refusal('b@x.io', 551, ''),
        ],
      },
      3,
    );

    expect(error?.message).toContain('2 of 3 recipients refused (SMTP 551)');
  });

  it('does not say the rest accepted when nobody did', () => {
    const error = refusedRecipientsError({ rejected: ['a@x.io', 'b@x.io'] }, 2);

    expect(error?.message).toBe('SMTP delivery incomplete: 2 of 2 recipients refused');
  });

  it('never carries the server text, an address or a cause', () => {
    const error = refusedRecipientsError(
      {
        rejected: ['typo@x.io'],
        rejectedErrors: [refusal('typo@x.io', 550, '550 5.1.1 <typo@x.io> unknown token s3cr3t')],
      },
      2,
    );

    expect(error?.message).not.toMatch(/typo|s3cr3t|unknown|no such/);
    expect(error?.cause).toBeUndefined();
  });

  it('has no retry fact, so a reply code that is transient on its own is not retried', () => {
    const error = refusedRecipientsError(
      { rejected: ['a@x.io'], rejectedErrors: [refusal('a@x.io', 450, '450 mailbox busy')] },
      2,
    );

    expect(error).toBeDefined();
    expect(deliveryFacts(error)).toEqual({
      code: undefined,
      originalCode: undefined,
      status: undefined,
      responseCode: undefined,
      timeoutType: undefined,
    });
  });
});
