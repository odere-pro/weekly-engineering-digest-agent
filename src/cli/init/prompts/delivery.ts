import { z } from 'zod';
import { EmailDeliverySchema } from '../../../config/schema';
import type { EmailAnswers, InitPrompts } from '../types';
import { isEmail, splitList, validateWith } from './validate';

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_PORT = 465;
const HttpsUrlSchema = z.url({ protocol: /^https$/ });

/** The SMTP settings, which go to the config, and the password, which goes to `.env` only. */
export async function askEmail(prompts: InitPrompts): Promise<EmailAnswers> {
  const shape = EmailDeliverySchema.shape;
  const host = await prompts.input({
    message: 'SMTP host',
    validate: validateWith(shape.host, 'host name'),
  });
  const port = await prompts.input({
    message: 'SMTP port',
    default: String(DEFAULT_SMTP_PORT),
    validate: (value) => shape.port.safeParse(Number(value)).success || 'Enter a port, 1-65535',
  });
  const secure = await prompts.confirm({
    message: 'Use implicit TLS (TLS from the first byte, usually port 465)?',
    default: Number(port) === IMPLICIT_TLS_PORT,
  });
  const user = await prompts.input({
    message: 'SMTP user',
    validate: validateWith(shape.user, 'user name'),
  });
  const from = await prompts.input({
    message: 'From address',
    ...(isEmail(user) && { default: user.trim() }),
    validate: validateWith(shape.from, 'email address'),
  });
  const to = await prompts.input({
    message: 'Recipients (comma-separated)',
    validate: (value) =>
      shape.to.safeParse(splitList(value)).success || 'Enter one or more email addresses',
  });
  const secret = await prompts.password({
    message: 'SMTP password',
    validate: (value) => value.length > 0 || 'Enter the password',
  });
  return {
    delivery: {
      host: host.trim(),
      port: Number(port),
      secure,
      requireTLS: true,
      user: user.trim(),
      from: from.trim(),
      to: splitList(to),
    },
    password: secret,
  };
}

/** The Slack incoming webhook. It is a secret, so it is read like a password and goes to `.env`. */
export async function askSlackWebhook(prompts: InitPrompts): Promise<string> {
  const webhook = await prompts.password({
    message: 'Slack webhook URL',
    validate: validateWith(HttpsUrlSchema, 'https URL'),
  });
  return webhook.trim();
}
