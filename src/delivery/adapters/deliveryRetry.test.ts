// W5-12: the retry decision, end to end. The real SMTP and Slack adapters throw the error a failed
// call produced (shaped like nodemailer's and fetch's), and withDeliveryRetry decides from the
// typed facts the adapter kept. No network: the transport and fetch are fakes.
import { describe, expect, it, vi } from 'vitest';
import { createSlackDelivery } from './slack';
import { createSmtpDelivery, type MailTransport } from './smtp';
import { withDeliveryRetry } from '../../app/retryingDelivery';
import type { DigestMessage, FailureNote } from '../Delivery';
import type { LogFields, Logger } from '../../shared/telemetry';

const PASSWORD = 'hunter2-app-password';
const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/s3cr3tT0ken';
const MESSAGE: DigestMessage = { weekId: '2026-W42', subject: 'Digest', markdown: '# Digest' };
const NOTE: FailureNote = { weekId: '2026-W42', step: 'deliver', message: 'it broke' };

function withProps(error: Error, props: Record<string, unknown>): Error {
  return Object.assign(error, props);
}

/** What nodemailer rejects with, by the shape its source gives each failure. */
const nodemailer = {
  refused: () =>
    withProps(new Error('connect ECONNREFUSED 127.0.0.1:587'), {
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
      command: 'CONN',
    }),
  dnsMiss: () =>
    withProps(new Error('getaddrinfo ENOTFOUND smtp.example.test'), {
      code: 'EDNS',
      originalCode: 'ENOTFOUND',
      command: 'CONN',
    }),
  timeout: (timeoutType: string, message: string) =>
    withProps(new Error(message), { code: 'ETIMEDOUT', timeoutType, command: 'CONN' }),
  reset: () =>
    withProps(new Error('read ECONNRESET'), {
      code: 'ESOCKET',
      originalCode: 'ECONNRESET',
      command: 'CONN',
    }),
  closed: () =>
    withProps(new Error('Connection closed unexpectedly'), {
      code: 'ECONNECTION',
      command: 'CONN',
    }),
  reply: (responseCode: number, code: string, message: string) =>
    withProps(new Error(`${message}: ${String(responseCode)} reply`), {
      code,
      responseCode,
      command: 'DATA',
    }),
};

function smtpWith(rejection: unknown) {
  const sendMail = vi.fn<MailTransport['sendMail']>();
  sendMail.mockRejectedValueOnce(rejection).mockResolvedValue({});
  const smtp = createSmtpDelivery({
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    user: 'digest@example.test',
    password: PASSWORD,
    from: 'digest@example.test',
    to: ['me@example.test'],
    createTransport: () => ({ sendMail }),
  });
  return { sendMail, smtp };
}

function slackWith(rejection: Response | Error) {
  const post = vi.fn<typeof fetch>();
  post
    .mockImplementationOnce(() =>
      rejection instanceof Response ? Promise.resolve(rejection) : Promise.reject(rejection),
    )
    .mockImplementation(() => Promise.resolve(new Response('ok', { status: 200 })));
  return { post, slack: createSlackDelivery({ webhookUrl: WEBHOOK, fetch: post }) };
}

interface Recorded {
  readonly logger: Logger;
  readonly lines: { message: string; fields: LogFields }[];
}

function recordingLogger(): Recorded {
  const lines: Recorded['lines'] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields = {}) => void lines.push({ message, fields }),
    error: () => undefined,
    child: () => logger,
  };
  return { logger, lines };
}

describe('SMTP: what is retried', () => {
  it.each([
    ['a refused connection', nodemailer.refused()],
    ['a host that did not resolve', nodemailer.dnsMiss()],
    ['a connect timeout', nodemailer.timeout('CONNECT_TIMEOUT', 'Connection timeout')],
    ['a greeting timeout', nodemailer.timeout('GREETING_TIMEOUT', 'Greeting never received')],
    ['a TLS upgrade timeout', nodemailer.timeout('UPGRADE_TIMEOUT', 'TLS handshake timed out')],
    ['a 421 reply', nodemailer.reply(421, 'ECONNECTION', 'Service not available')],
    ['a 450 reply', nodemailer.reply(450, 'EENVELOPE', 'Mailbox busy')],
    ['a 451 reply', nodemailer.reply(451, 'EMESSAGE', 'Message failed')],
  ])('sends again after %s', async (_name, rejection) => {
    const { sendMail, smtp } = smtpWith(rejection);
    const { logger, lines } = recordingLogger();
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await withDeliveryRetry(smtp, { logger, sleep }).sendDigest(MESSAGE);

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['a reset connection', nodemailer.reset()],
    [
      'a socket timeout, which can come after the body',
      nodemailer.timeout('SOCKET_TIMEOUT', 'Timeout'),
    ],
    ['a connection that closed unexpectedly', nodemailer.closed()],
    ['a 452 reply', nodemailer.reply(452, 'EENVELOPE', 'Storage full')],
    ['a 550 reply', nodemailer.reply(550, 'EENVELOPE', 'No such user')],
    ['a 535 reply', nodemailer.reply(535, 'EAUTH', 'Invalid login')],
  ])('sends once and throws after %s: the mail may already be out', async (_name, rejection) => {
    const { sendMail, smtp } = smtpWith(rejection);
    const { logger } = recordingLogger();
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const delivery = withDeliveryRetry(smtp, { logger, sleep });

    await expect(delivery.sendDigest(MESSAGE)).rejects.toThrow(/SMTP delivery failed/);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats a failure note like the digest', async () => {
    const reset = smtpWith(nodemailer.reset());
    const refused = smtpWith(nodemailer.refused());
    const { logger } = recordingLogger();
    const sleep = (): Promise<void> => Promise.resolve();

    await expect(
      withDeliveryRetry(reset.smtp, { logger, sleep }).sendFailure(NOTE),
    ).rejects.toThrow();
    await withDeliveryRetry(refused.smtp, { logger, sleep }).sendFailure(NOTE);

    expect(reset.sendMail).toHaveBeenCalledTimes(1);
    expect(refused.sendMail).toHaveBeenCalledTimes(2);
  });

  it('keeps the password out of what the retry logs', async () => {
    const leaky = withProps(new Error(`connect ECONNREFUSED, AUTH ${PASSWORD}`), {
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
    });
    const { smtp } = smtpWith(leaky);
    const { logger, lines } = recordingLogger();

    await withDeliveryRetry(smtp, { logger, sleep: () => Promise.resolve() }).sendDigest(MESSAGE);

    expect(JSON.stringify(lines)).not.toContain(PASSWORD);
    expect(lines[0]?.fields).toMatchObject({ code: 'ESOCKET' });
  });
});

describe('Slack: what is retried', () => {
  const refusedBothAddresses = withProps(
    new AggregateError([
      new Error('connect ECONNREFUSED ::1:443'),
      new Error('connect ECONNREFUSED 127.0.0.1:443'),
    ]),
    { code: 'ECONNREFUSED' },
  );

  it.each([
    ['an HTTP 429', new Response('', { status: 429 })],
    ['an HTTP 500', new Response('', { status: 500 })],
    ['an HTTP 503', new Response('', { status: 503 })],
    [
      'a refused connection on both addresses',
      new TypeError('fetch failed', { cause: refusedBothAddresses }),
    ],
    [
      'a name that did not resolve',
      new TypeError('fetch failed', {
        cause: withProps(new Error('getaddrinfo ENOTFOUND hooks.slack.test'), {
          code: 'ENOTFOUND',
        }),
      }),
    ],
    [
      'an undici connect timeout',
      new TypeError('fetch failed', {
        cause: withProps(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      }),
    ],
  ])('posts again after %s', async (_name, rejection) => {
    const { post, slack } = slackWith(rejection);
    const { logger, lines } = recordingLogger();

    await withDeliveryRetry(slack, { logger, sleep: () => Promise.resolve() }).sendDigest(MESSAGE);

    expect(post).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['an HTTP 400', new Response('', { status: 400 })],
    ['an HTTP 404', new Response('', { status: 404 })],
    [
      'a reset connection',
      new TypeError('fetch failed', {
        cause: withProps(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      }),
    ],
    [
      'an undici socket error',
      new TypeError('fetch failed', {
        cause: withProps(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }),
    ],
    [
      'a timeout of the whole request',
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    ],
    [
      'a refused redirect',
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    ],
  ])('posts once and throws after %s: the message may already be out', async (_name, rejection) => {
    const { post, slack } = slackWith(rejection);
    const { logger } = recordingLogger();
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(withDeliveryRetry(slack, { logger, sleep }).sendDigest(MESSAGE)).rejects.toThrow(
      /Slack webhook/,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps the webhook out of what the retry logs, and says the status it retried on', async () => {
    const { slack } = slackWith(new Response(`bad ${WEBHOOK}`, { status: 502 }));
    const { logger, lines } = recordingLogger();

    await withDeliveryRetry(slack, { logger, sleep: () => Promise.resolve() }).sendFailure(NOTE);

    expect(JSON.stringify(lines)).not.toContain('s3cr3tT0ken');
    expect(lines[0]?.fields).toMatchObject({ status: 502, operation: 'sendFailure' });
  });
});
