import type { ProfileName } from '../../../config/schema';
import { DEFAULT_FOCUS_AREAS } from '../../../sources/defaultSources';
import type { Answers, Host, InitIo } from '../types';
import { askEmail, askSlackWebhook } from './delivery';
import { askFocusAreas } from './focusAreas';
import { askProfile } from './profile';
import { localFolder, requireSaveLocally, saveLocallyChoice } from './saveLocally';
import { askTimeZone } from './timeZone';

/** What `--yes` takes: the recommended profile, this process's time zone, the default focus areas. */
export function defaultAnswers(io: InitIo, recommended: ProfileName): Answers {
  return {
    profile: recommended,
    timeZone: io.timeZone,
    focusAreas: [...DEFAULT_FOCUS_AREAS],
  };
}

/**
 * The questions in order: focus areas, profile, time zone, then the delivery channels. Saving
 * locally comes ticked and stays ticked; email and Slack are the extra channels.
 */
export async function askAnswers(
  io: InitIo,
  host: Host,
  recommended: ProfileName,
): Promise<Answers> {
  const { prompts } = io;
  const focusAreas = await askFocusAreas(prompts);
  const profile = await askProfile(io, host, recommended);
  const timeZone = await askTimeZone(io, host.inDocker);
  const folder = localFolder(io, { timeZone, inDocker: host.inDocker });
  const channels = await prompts.checkbox({
    message: 'Deliver the digest to',
    choices: [
      saveLocallyChoice(folder),
      { name: 'Email (SMTP)', value: 'email' },
      { name: 'Slack (incoming webhook)', value: 'slack' },
    ],
    validate: requireSaveLocally,
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
