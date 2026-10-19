import { QUALITY_UNMEASURED } from '../prompts/profile';
import { isContainerDefaultZone } from '../prompts/timeZone';
import type { Answers } from '../types';

const DOCKER_NEXT_STEPS =
  '\nNext: "docker compose up -d" starts the weekly schedule. Run "digest doctor" first to check the setup.\n';

/** A container on UTC would run the Monday 07:45 digest at 07:45 UTC, so say how to change it. */
export function dockerNextSteps(timeZone: string): string {
  if (!isContainerDefaultZone(timeZone)) return DOCKER_NEXT_STEPS;
  return `\nThe schedule runs on ${timeZone}. For your local time, set schedule.timeZone in digest.config.json (for example "Europe/Berlin").\n${DOCKER_NEXT_STEPS}`;
}

/** What init printed it wrote and chose. The answers' secrets (password, webhook) are never in it. */
export function summary(info: {
  configPath: string;
  envPath: string;
  answers: Answers;
  ollamaUrl: string;
  envMerged: boolean;
  /** Where this week's Markdown and HTML files go (`prompts/saveLocally`). */
  localFolder: string;
}): string {
  const { answers } = info;
  const channels = [
    'markdown',
    ...(answers.email ? ['email'] : []),
    ...(answers.slackWebhook ? ['slack'] : []),
  ];
  const written = info.envMerged
    ? `Wrote ${info.configPath} and updated ${info.envPath} (kept its other settings; readable by you only).`
    : `Wrote ${info.configPath} and ${info.envPath} (readable by you only).`;
  return [
    written,
    `  profile:  ${answers.profile}`,
    ...(answers.profile === 'quality'
      ? [
          `  note:     ${QUALITY_UNMEASURED}; set "profile" to "light" in ${info.configPath} for a shorter week.`,
        ]
      : []),
    `  focus:    ${answers.focusAreas.join(', ')}`,
    `  delivery: ${channels.join(', ')}`,
    `  saved to: ${info.localFolder} (one folder per week)`,
    `  schedule: ${info.answers.timeZone}`,
    `  ollama:   ${info.ollamaUrl}`,
    '',
  ].join('\n');
}
