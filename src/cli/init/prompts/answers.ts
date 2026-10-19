import type { ProfileName } from '../../../config/schema';
import { DEFAULT_FOCUS_AREAS } from '../../../sources/defaultSources';
import type { Answers, Host, InitIo } from '../types';
import { askEmail, askSlackWebhook } from './delivery';
import { askFocusAreas } from './focusAreas';
import { askProfile } from './profile';
import { askTimeZone } from './timeZone';

/** What `--yes` takes: the recommended profile, this process's time zone, the default focus areas. */
export function defaultAnswers(io: InitIo, recommended: ProfileName): Answers {
  return {
    profile: recommended,
    timeZone: io.timeZone,
    focusAreas: [...DEFAULT_FOCUS_AREAS],
  };
}

/** The questions in order: focus areas, profile, time zone, then the extra delivery channels. */
export async function askAnswers(
  io: InitIo,
  host: Host,
  recommended: ProfileName,
): Promise<Answers> {
  const { prompts } = io;
  const focusAreas = await askFocusAreas(prompts);
  const profile = await askProfile(io, host, recommended);
  const timeZone = await askTimeZone(io, host.inDocker);
  const channels = await prompts.checkbox({
    message: 'Also deliver the digest by (Markdown files are always written)',
    choices: [
      { name: 'Email (SMTP)', value: 'email' },
      { name: 'Slack (incoming webhook)', value: 'slack' },
    ],
  });
  const email = channels.includes('email') ? await askEmail(prompts) : undefined;
  const slackWebhook = channels.includes('slack') ? await askSlackWebhook(prompts) : undefined;
  return {
    profile,
    timeZone,
    focusAreas,
    ...(email && { email }),
    ...(slackWebhook && { slackWebhook }),
  };
}
