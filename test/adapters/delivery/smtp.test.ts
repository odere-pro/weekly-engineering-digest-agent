import { describe, expect, it, vi } from 'vitest';
import { createSmtpDelivery, type SmtpOptions } from '../../../src/adapters/delivery/smtp.js';

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
      auth: { user: 'digest@example.test', pass: PASSWORD },
      ...TIMEOUTS,
    });
    expect(sendMail).toHaveBeenCalledOnce();
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
});
