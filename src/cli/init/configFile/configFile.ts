import type { z } from 'zod';
import { DEFAULT_SOURCES } from '../../../sources/defaultSources';
import { ConfigSchema, type ConfigInput } from '../../../config/schema';
import { DigestError } from '../../../shared/errors';
import type { Answers } from '../types';
import { describeIssues } from './describeIssues';

/** The config the answers describe. Secrets are not in it: the email password and webhook go to `.env`. */
export function buildConfigInput(answers: Answers): ConfigInput {
  const delivery = {
    ...(answers.email && { email: answers.email.delivery }),
    ...(answers.slackWebhook !== undefined && { slack: { enabled: true } }),
  };
  return {
    profile: answers.profile,
    focusAreas: answers.focusAreas,
    schedule: { timeZone: answers.timeZone },
    sources: [...DEFAULT_SOURCES],
    ...(Object.keys(delivery).length > 0 && { delivery }),
  };
}

/** The parsed config, or a `DigestError` that lists the failing fields: nothing is written then. */
export function validatedConfig(input: ConfigInput): z.output<typeof ConfigSchema> {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw new DigestError(
      `Those answers do not make a valid config, nothing was written.\n${describeIssues(result.error)}`,
    );
  }
  return result.data;
}

/** The text of `digest.config.json`: two-space JSON and a final newline. */
export function toJson(input: ConfigInput): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}
