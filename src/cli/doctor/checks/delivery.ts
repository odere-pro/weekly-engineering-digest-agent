import type { LoadedConfig } from '../../../config/load';
import { checkWritableDir, markdownDirCheck } from '../folders/writableDir';
import type { DirIo } from '../folders/inspectDir';
import { fail, ok, type CheckResult } from '../report/checkResult';

/**
 * The markdown folder, and the secret each configured channel needs. Nothing is sent: only the
 * presence of `SMTP_PASSWORD` and `SLACK_WEBHOOK_URL` is looked at, never their values.
 */
export async function checkDelivery(
  { config, secrets }: Pick<LoadedConfig, 'config' | 'secrets'>,
  io: DirIo,
): Promise<CheckResult[]> {
  const { email, slack, markdown } = config.delivery;
  return [
    await checkWritableDir(markdownDirCheck(markdown.dir), io),
    ...(email
      ? [
          secrets.SMTP_PASSWORD
            ? ok(
                'email',
                `SMTP_PASSWORD is set (${email.to.length} recipient(s) via ${email.host})`,
              )
            : fail(
                'email',
                'email delivery is configured but SMTP_PASSWORD is not set',
                'add SMTP_PASSWORD=<password> to .env',
              ),
        ]
      : []),
    ...(slack?.enabled
      ? [
          secrets.SLACK_WEBHOOK_URL
            ? ok('slack', 'SLACK_WEBHOOK_URL is set')
            : fail(
                'slack',
                'Slack delivery is enabled but SLACK_WEBHOOK_URL is not set',
                'add SLACK_WEBHOOK_URL=<webhook url> to .env',
              ),
        ]
      : []),
  ];
}
