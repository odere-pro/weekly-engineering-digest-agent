import { describe, expect, it, vi } from 'vitest';
import { DeliveryError } from '../../../src/adapters/delivery/deliveryError.js';
import { renderEmailHtml, renderEmailText } from '../../../src/adapters/delivery/emailRender.js';
import {
  createSmtpDelivery,
  type SmtpOptions,
  type SmtpTransportConfig,
} from '../../../src/adapters/delivery/smtp.js';
import type { DigestView } from '../../../src/ports/Delivery.js';

const nodemailer = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock('nodemailer', () => nodemailer);

const PASSWORD = 'hunter2-app-password';

const baseOptions: SmtpOptions = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'digest@example.test',
  password: PASSWORD,
  from: 'Digest <digest@example.test>',
  to: ['me@example.test', 'team@example.test'],
};

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 };

const message = {
  weekId: '2026-W42',
  subject: 'Engineering digest 2026-W42',
  markdown: '# Digest\n\nbcc: attacker@evil.test\n',
};

const view: DigestView = {
  weekId: '2026-W42',
  title: 'Week 2026-W42: 1 release, 1 needs action',
  headline: 'One fix needs action.',
  groups: [
    {
      urgency: 'act-now',
      label: 'Act now',
      items: [
        {
          title: 'Ollama v0.13.0',
          url: 'https://github.com/ollama/ollama/releases/tag/v0.13.0',
          whatChanged: 'Fixes a crash.',
          action: 'Upgrade.',
        },
      ],
    },
  ],
};

function fakeTransport() {
  const sendMail = vi.fn<(mail: unknown) => Promise<unknown>>(() => Promise.resolve({}));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
}

describe('createSmtpDelivery', () => {
  it('identifies as the email channel', () => {
    const { createTransport } = fakeTransport();
    expect(createSmtpDelivery({ ...baseOptions, createTransport }).id).toBe('email');
  });

  it('opens the transport with the server settings and credentials', () => {
    const { createTransport } = fakeTransport();
    createSmtpDelivery({ ...baseOptions, createTransport });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'digest@example.test', pass: PASSWORD },
      ...TIMEOUTS,
    });
  });

  it('uses nodemailer createTransport when no factory is injected', async () => {
    const { sendMail, createTransport } = fakeTransport();
    nodemailer.createTransport.mockImplementation(createTransport);

    await createSmtpDelivery(baseOptions).sendDigest(message);

    expect(nodemailer.createTransport).toHaveBeenCalledExactlyOnceWith({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'digest@example.test', pass: PASSWORD },
      ...TIMEOUTS,
    });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('requires STARTTLS by default and lets a local mail catcher opt out', () => {
    const seen: boolean[] = [];
    const createTransport = (config: SmtpTransportConfig) => {
      seen.push(config.requireTLS);
      return { sendMail: vi.fn() };
    };
    createSmtpDelivery({ ...baseOptions, createTransport });
    createSmtpDelivery({ ...baseOptions, requireTLS: false, createTransport });

    expect(seen).toEqual([true, false]);
  });

  it('refuses to start without any recipient', () => {
    const { createTransport } = fakeTransport();

    expect(() => createSmtpDelivery({ ...baseOptions, to: [], createTransport })).toThrow(
      /recipient/i,
    );
  });

  describe('sendDigest', () => {
    it('sends the markdown as the plain-text body with the message subject', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest(message);

      expect(sendMail).toHaveBeenCalledWith({
        from: 'Digest <digest@example.test>',
        to: ['me@example.test', 'team@example.test'],
        subject: 'Engineering digest 2026-W42',
        text: message.markdown,
      });
    });

    it('sends the markdown text only, with no html key, when the message has no view', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest(message);

      const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(mail).sort()).toEqual(['from', 'subject', 'text', 'to']);
    });

    it('sends a text part and an html part rendered from the view when there is one', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest({
        ...message,
        view,
      });

      expect(sendMail).toHaveBeenCalledExactlyOnceWith({
        from: 'Digest <digest@example.test>',
        to: ['me@example.test', 'team@example.test'],
        subject: 'Engineering digest 2026-W42',
        text: renderEmailText(view),
        html: renderEmailHtml(view),
      });
    });

    it('renders the text part from the view, not from the markdown', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest({
        ...message,
        view,
      });

      const mail = sendMail.mock.calls[0]?.[0] as { text: string; html: string };
      expect(mail.text).toContain('Ollama v0.13.0');
      expect(mail.text).not.toContain('# Digest');
      expect(mail.html).toContain('<h1');
    });

    it('takes recipients from the options only, never from the message', async () => {
      const { sendMail, createTransport } = fakeTransport();
      const hostile = {
        ...message,
        subject: 'Hi\r\nBcc: attacker@evil.test',
        to: ['attacker@evil.test'],
        cc: 'attacker@evil.test',
      };
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest(hostile);

      const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(mail.to).toEqual(baseOptions.to);
      expect(Object.keys(mail).sort()).toEqual(['from', 'subject', 'text', 'to']);
    });

    it('keeps the recipients and the sender when a hostile message carries a view', async () => {
      const { sendMail, createTransport } = fakeTransport();
      const hostile = { ...message, view, to: ['attacker@evil.test'], html: '<b>x</b>' };
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest(hostile);

      const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(mail.to).toEqual(baseOptions.to);
      expect(mail.from).toBe(baseOptions.from);
      expect(mail.html).toBe(renderEmailHtml(view));
      expect(Object.keys(mail).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    });

    it('keeps the recipients it was created with when the caller changes the array later', async () => {
      const { sendMail, createTransport } = fakeTransport();
      const to = ['me@example.test'];
      const delivery = createSmtpDelivery({ ...baseOptions, to, createTransport });
      to.push('late@example.test');
      await delivery.sendDigest(message);

      expect((sendMail.mock.calls[0]?.[0] as { to: string[] }).to).toEqual(['me@example.test']);
    });

    it('throws an error without the password when sending fails', async () => {
      const { sendMail, createTransport } = fakeTransport();
      sendMail.mockRejectedValue(new Error(`535 auth failed for ${PASSWORD}`));

      const error = await createSmtpDelivery({ ...baseOptions, createTransport })
        .sendDigest(message)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/smtp/i);
      expect((error as Error).message).toContain('535 auth failed');
      expect((error as Error).message).not.toContain(PASSWORD);
      expect((error as Error).cause).toBeUndefined();
    });

    it('reports a non-Error rejection', async () => {
      const { sendMail, createTransport } = fakeTransport();
      sendMail.mockRejectedValue('connection refused');

      await expect(
        createSmtpDelivery({ ...baseOptions, createTransport }).sendDigest(message),
      ).rejects.toThrow(/connection refused/);
    });
  });

  describe('sendFailure', () => {
    it('mails a short failure note to the configured recipients', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendFailure({
        weekId: '2026-W42',
        step: 'deliver',
        message: 'Slack answered 500',
      });

      const mail = sendMail.mock.calls[0]?.[0] as Record<string, string | string[]>;
      expect(mail.to).toEqual(baseOptions.to);
      expect(mail.from).toBe(baseOptions.from);
      expect(mail.subject).toContain('2026-W42');
      expect(mail.subject).toMatch(/failed/i);
      expect(mail.text).toContain('deliver');
      expect(mail.text).toContain('Slack answered 500');
    });

    it('stays text-only, with no html part', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendFailure({
        weekId: '2026-W42',
        message: 'Ollama is not reachable',
      });

      const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(mail).sort()).toEqual(['from', 'subject', 'text', 'to']);
    });

    it('removes the password from a message that echoes it', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendFailure({
        weekId: '2026-W42',
        message: `login failed with ${PASSWORD}`,
      });

      const mail = sendMail.mock.calls[0]?.[0] as { text: string };
      expect(mail.text).not.toContain(PASSWORD);
      expect(mail.text).toContain('[redacted]');
    });

    it('omits the step when none is known', async () => {
      const { sendMail, createTransport } = fakeTransport();
      await createSmtpDelivery({ ...baseOptions, createTransport }).sendFailure({
        weekId: '2026-W42',
        message: 'Ollama is not reachable',
      });

      const mail = sendMail.mock.calls[0]?.[0] as { text: string };
      expect(mail.text).toContain('Ollama is not reachable');
      expect(mail.text).not.toContain('undefined');
    });
  });

  describe('typed errors', () => {
    function nodemailerError(message: string, props: Record<string, unknown>): Error {
      return Object.assign(new Error(message), props);
    }

    async function sendFailing(error: unknown, which: 'digest' | 'note' = 'digest') {
      const { sendMail, createTransport } = fakeTransport();
      sendMail.mockRejectedValue(error);
      const delivery = createSmtpDelivery({ ...baseOptions, createTransport });
      const sent =
        which === 'digest'
          ? delivery.sendDigest(message)
          : delivery.sendFailure({ weekId: '2026-W42', message: 'boom' });
      return (await sent.catch((caught: unknown) => caught)) as DeliveryError;
    }

    it('keeps the code, the system code under it and the command of a refused connection', async () => {
      const error = await sendFailing(
        nodemailerError('connect ECONNREFUSED 127.0.0.1:587', {
          code: 'ESOCKET',
          originalCode: 'ECONNREFUSED',
          command: 'CONN',
        }),
      );

      expect(error).toBeInstanceOf(DeliveryError);
      expect(error.code).toBe('ESOCKET');
      expect(error.originalCode).toBe('ECONNREFUSED');
    });

    it('keeps which timeout hit', async () => {
      const error = await sendFailing(
        nodemailerError('Connection timeout', {
          code: 'ETIMEDOUT',
          timeoutType: 'CONNECT_TIMEOUT',
        }),
      );

      expect(error.code).toBe('ETIMEDOUT');
      expect(error.timeoutType).toBe('CONNECT_TIMEOUT');
    });

    it('keeps the SMTP reply code of a server answer, for a failure note too', async () => {
      const error = await sendFailing(
        nodemailerError('Message failed: 451 4.3.0 Try again', {
          code: 'EMESSAGE',
          responseCode: 451,
          command: 'DATA',
        }),
        'note',
      );

      expect(error.responseCode).toBe(451);
      expect(error.code).toBe('EMESSAGE');
    });

    it('keeps a cause with the password removed from it', async () => {
      const error = await sendFailing(
        new Error('send failed', { cause: new Error(`AUTH with ${PASSWORD} refused`) }),
      );

      expect((error.cause as Error).message).toBe('AUTH with [redacted] refused');
    });
  });
});
