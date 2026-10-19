import { createTransport } from 'nodemailer';
import type { Delivery, DigestMessage } from '../Delivery';
import { renderEmailHtml } from './email/emailHtml';
import { renderEmailText } from './email/emailText';
import { failureTitle } from './errors/failureNote';
import { redactedError, redactSecrets } from './errors/redact';

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;

export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** With `text`, nodemailer sends multipart/alternative. */
  html?: string;
}

/** What varies between mails; the sender and recipients are fixed by the options. */
type MailContent = Pick<MailMessage, 'subject' | 'text' | 'html'>;

/** The slice of a nodemailer transport this adapter uses. */
export interface MailTransport {
  sendMail(mail: MailMessage): Promise<unknown>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  /** Require STARTTLS before AUTH (default true), so the password never travels in cleartext. */
  requireTLS?: boolean;
  user: string;
  /** From .env only. */
  password: string;
  from: string;
  /** From config only, never from model output. */
  to: readonly string[];
  /** Injected for tests; defaults to nodemailer's createTransport. */
  createTransport?: (config: SmtpTransportConfig) => MailTransport;
}

/** Email over the user's own SMTP server (W1-12). */
export function createSmtpDelivery(options: SmtpOptions): Delivery {
  if (options.to.length === 0) throw new Error('SMTP delivery needs at least one recipient');
  // Copied once: later changes to the caller's array must not change who gets the mail.
  const recipients = [...options.to];
  const transport = (options.createTransport ?? createTransport)({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTLS ?? true,
    auth: { user: options.user, pass: options.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  async function send(content: MailContent): Promise<void> {
    try {
      await transport.sendMail({ ...content, from: options.from, to: recipients });
    } catch (error) {
      throw redactedError('SMTP delivery failed', error, [options.password]);
    }
  }

  return {
    id: 'email',
    sendDigest: (message) => send(digestContent(message)),
    sendFailure: (note) => {
      const title = failureTitle(note);
      const reason = redactSecrets(note.message, [options.password]);
      return send({ subject: title, text: `${title}.\n\n${reason}\n` });
    },
  };
}

/**
 * With a view the mail carries a text part and an html part (multipart/alternative), both
 * rendered from the view. Without one it is today's text-only mail with the Markdown as body.
 */
function digestContent(message: DigestMessage): MailContent {
  const { view, subject } = message;
  if (!view) return { subject, text: message.markdown };
  return { subject, text: renderEmailText(view), html: renderEmailHtml(view) };
}
