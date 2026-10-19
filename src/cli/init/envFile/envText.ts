import { parseEnv } from 'node:util';
import { formatEnvValue, mergeEnvText, type EnvUpdate } from '../../../config/load';
import { SecretsSchema } from '../../../config/schema';
import { DigestError, errorMessage } from '../../../shared/errors';
import type { Answers, InitIo } from '../types';

export interface EnvFile {
  text: string;
  /** True when init's settings were merged into a file that already had some. */
  merged: boolean;
}

/** The secrets the answers carry, as `.env` keys. Names the keys, never the values, when one is invalid. */
export function secretsOf(answers: Answers): Record<string, string> {
  const secrets = {
    ...(answers.email && { SMTP_PASSWORD: answers.email.password }),
    ...(answers.slackWebhook !== undefined && { SLACK_WEBHOOK_URL: answers.slackWebhook }),
  };
  const parsed = SecretsSchema.safeParse(secrets);
  if (!parsed.success) {
    // Names the keys only: the values are secrets.
    const keys = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new DigestError(`Invalid secret value for ${keys}, nothing was written.`);
  }
  return secrets;
}

/** The text of a new `.env`: a header, `OLLAMA_URL`, the secrets, and a commented `GITHUB_TOKEN`. */
export function renderEnvFile(ollamaUrl: string, secrets: Record<string, string>): string {
  const lines = [
    '# Written by "digest init". Keep this file private and out of git.',
    `OLLAMA_URL=${formatEnvValue('OLLAMA_URL', ollamaUrl)}`,
    ...Object.entries(secrets).map(([key, value]) => `${key}=${formatEnvValue(key, value)}`),
    '# Optional: a GitHub token raises the API rate limit for release feeds.',
    '# GITHUB_TOKEN=',
  ];
  return `${lines.join('\n')}\n`;
}

/** A fresh file, or the existing one with init's settings merged into it. */
export async function buildEnvFile(
  io: InitIo,
  ollamaUrl: string,
  secrets: Record<string, string>,
): Promise<EnvFile> {
  const current = await readEnvFile(io);
  if (current === undefined || current.trim() === '') {
    return { text: renderEnvFile(ollamaUrl, secrets), merged: false };
  }
  const updates = envUpdates(current, ollamaUrl, secrets);
  return { text: mergeEnvText(current, updates, io.envPath), merged: true };
}

/** The current text of `.env`, undefined when there is none. A file that cannot be read stops init. */
export async function readEnvFile(io: InitIo): Promise<string | undefined> {
  try {
    return await io.readFile(io.envPath);
  } catch (error) {
    throw new DigestError(`Could not read ${io.envPath}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * What init sets in an existing file: every secret it was given, and OLLAMA_URL only when the
 * file has none (a hand-set URL is a choice, such as a remote Ollama). A secret it was not given
 * is left alone.
 */
export function envUpdates(
  current: string,
  ollamaUrl: string,
  secrets: Record<string, string>,
): EnvUpdate[] {
  const hasUrl = (parseEnv(current)['OLLAMA_URL'] ?? '') !== '';
  return [
    ...(hasUrl ? [] : [{ key: 'OLLAMA_URL', value: ollamaUrl }]),
    ...Object.entries(secrets).map(([key, value]) => ({ key, value })),
  ];
}
