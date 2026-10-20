import type { Secrets } from '../../config/schema';
import { urlCredentialSecrets } from '../../models/adapters/endpoint';

/**
 * Every secret value that is set, plus the path of the Slack webhook (the path is the secret part
 * of that URL, and a message can carry it without the host) and the password of `OLLAMA_URL`, which
 * is not in `Secrets` because the loader reads it as a plain setting. Pass `env.OLLAMA_URL` as
 * `ollamaUrl` wherever the run's output is redacted.
 */
export function knownSecrets(secrets: Secrets, ollamaUrl?: string): string[] {
  const values = Object.values(secrets).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const path = webhookPath(secrets.SLACK_WEBHOOK_URL);
  const ollama = ollamaUrl === undefined ? [] : urlCredentialSecrets(ollamaUrl);
  return [...values, ...(path === undefined ? [] : [path]), ...ollama];
}

function webhookPath(webhookUrl: string | undefined): string | undefined {
  if (webhookUrl === undefined || webhookUrl === '') return undefined;
  try {
    const { pathname } = new URL(webhookUrl);
    return pathname.length > 1 ? pathname : undefined;
  } catch {
    return undefined;
  }
}
