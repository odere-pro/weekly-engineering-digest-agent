import type { Secrets } from '../../config/schema';

/**
 * Every secret value that is set, plus the path of the Slack webhook: the path is the secret part
 * of that URL, and a message can carry it without the host. Comes from the loaded secrets only.
 */
export function knownSecrets(secrets: Secrets): string[] {
  const values = Object.values(secrets).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const path = webhookPath(secrets.SLACK_WEBHOOK_URL);
  return path === undefined ? values : [...values, path];
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
