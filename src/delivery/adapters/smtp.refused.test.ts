// nodemailer throws only when every recipient is refused. With some accepted it resolves with
// { accepted, rejected, rejectedErrors }, and the adapter must not count that as delivered.
import { describe, expect, it, vi } from 'vitest';
import { DeliveryError } from './errors/deliveryError';
import { createSmtpDelivery, type MailTransport } from './smtp';
import type { DigestMessage } from '../Delivery';

const PASSWORD = 'hunter2-app-password';
const MESSAGE: DigestMessage = { weekId: '2026-W42', subject: 'Digest', markdown: '# Digest' };

function smtpAnswering(answer: unknown) {
  const sendMail = vi.fn<MailTransport['sendMail']>(() => Promise.resolve(answer));
  const smtp = createSmtpDelivery({
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    user: 'digest@example.test',
    password: PASSWORD,
    from: 'digest@example.test',
    to: ['good@x.io', 'typo@x.io'],
    createTransport: () => ({ sendMail }),
  });
  return { sendMail, smtp };
}

const partlyRefused = {
  accepted: ['good@x.io'],
  rejected: ['typo@x.io'],
  rejectedErrors: [
    Object.assign(new Error('Recipient command failed'), {
      code: 'EENVELOPE',
      recipient: 'typo@x.io',
      responseCode: 550,
      response: `550 5.1.1 <typo@x.io> unknown user, token ${PASSWORD}`,
    }),
  ],
};

describe('a mail the server took for only some recipients', () => {
  it('fails the digest, saying how many were refused and with which reply code', async () => {
    const { smtp } = smtpAnswering(partlyRefused);

    const error: unknown = await smtp.sendDigest(MESSAGE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as DeliveryError).message).toBe(
      'SMTP delivery incomplete: 1 of 2 recipients refused (SMTP 550); the rest accepted the mail',
    );
  });

  it('never puts the server text, an address or the password in the error', async () => {
    const { smtp } = smtpAnswering(partlyRefused);

    const error = (await smtp.sendDigest(MESSAGE).catch((caught: unknown) => caught)) as Error;

    const everything = JSON.stringify({ message: error.message, cause: error.cause });
    expect(everything).not.toMatch(/typo|unknown user|hunter2/);
    expect(error.cause).toBeUndefined();
  });

  it('fails a failure note the same way', async () => {
    const { smtp } = smtpAnswering(partlyRefused);

    await expect(smtp.sendFailure({ weekId: '2026-W42', message: 'boom' })).rejects.toThrow(
      /1 of 2 recipients refused/,
    );
  });

  it('sends the mail once: the adapter itself does not try again', async () => {
    const { sendMail, smtp } = smtpAnswering(partlyRefused);

    await smtp.sendDigest(MESSAGE).catch(() => undefined);

    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('fails even when the server gave no reply code for the refusal', async () => {
    const { smtp } = smtpAnswering({ accepted: ['good@x.io'], rejected: ['typo@x.io'] });

    await expect(smtp.sendDigest(MESSAGE)).rejects.toThrow(
      'SMTP delivery incomplete: 1 of 2 recipients refused; the rest accepted the mail',
    );
  });
});

describe('a mail the server took for every recipient', () => {
  it.each([
    ['accepted and an empty rejected list', { accepted: ['good@x.io', 'typo@x.io'], rejected: [] }],
    ['accepted only', { accepted: ['good@x.io', 'typo@x.io'] }],
    ['an empty answer', {}],
    ['no answer', undefined],
  ])('is delivered, with %s', async (_name, answer) => {
    const { sendMail, smtp } = smtpAnswering(answer);

    await smtp.sendDigest(MESSAGE);
    await smtp.sendFailure({ weekId: '2026-W42', message: 'boom' });

    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
