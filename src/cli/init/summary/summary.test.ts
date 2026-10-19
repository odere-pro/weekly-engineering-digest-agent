import { describe, expect, it } from 'vitest';
import { QUALITY_UNMEASURED } from '../prompts/profile';
import type { Answers } from '../types';
import { dockerNextSteps, summary } from './summary';

const CONFIG_PATH = '/work/digest.config.json';
const ENV_PATH = '/work/.env';
const OLLAMA_URL = 'http://localhost:11434';
const FOLDER = '/work/dist/2026-10-19/digest/';
const BASE: Answers = {
  profile: 'light',
  timeZone: 'Europe/Berlin',
  focusAreas: ['AI models and tooling', 'Platform engineering'],
};

const summaryOf = (answers: Answers, envMerged = false, localFolder = FOLDER): string =>
  summary({
    configPath: CONFIG_PATH,
    envPath: ENV_PATH,
    answers,
    ollamaUrl: OLLAMA_URL,
    envMerged,
    localFolder,
  });

describe('summary', () => {
  it('lists what was written, the profile, focus areas, delivery, folder, zone and Ollama URL', () => {
    expect(summaryOf(BASE)).toBe(
      [
        'Wrote /work/digest.config.json and /work/.env (readable by you only).',
        '  profile:  light',
        '  focus:    AI models and tooling, Platform engineering',
        '  delivery: markdown',
        '  saved to: /work/dist/2026-10-19/digest/ (one folder per week)',
        '  schedule: Europe/Berlin',
        '  ollama:   http://localhost:11434',
        '',
      ].join('\n'),
    );
  });

  it('says it updated .env and kept the rest when it merged into an existing file', () => {
    const text = summaryOf(BASE, true);

    expect(text.split('\n')[0]).toBe(
      `Wrote ${CONFIG_PATH} and updated ${ENV_PATH} (kept its other settings; readable by you only).`,
    );
  });

  it('keeps the plain wording for a fresh file', () => {
    expect(summaryOf(BASE, false)).toContain(
      `Wrote ${CONFIG_PATH} and ${ENV_PATH} (readable by you only).`,
    );
  });

  it('lists the extra delivery channels after markdown', () => {
    const email = { delivery: undefined, password: 'smtp-secret' };

    expect(summaryOf({ ...BASE, email })).toContain('  delivery: markdown, email\n');
    expect(summaryOf({ ...BASE, slackWebhook: 'https://hooks.slack.com/x' })).toContain(
      '  delivery: markdown, slack\n',
    );
    expect(summaryOf({ ...BASE, email, slackWebhook: 'https://hooks.slack.com/x' })).toContain(
      '  delivery: markdown, email, slack\n',
    );
  });

  it('names the folder the Markdown files go to, as it was given', () => {
    expect(summaryOf(BASE, false, './dist/2026-10-19/digest/ on the host')).toContain(
      '  saved to: ./dist/2026-10-19/digest/ on the host (one folder per week)\n',
    );
  });

  it('names the folder with the extra channels too, right after the delivery line', () => {
    const lines = summaryOf({ ...BASE, slackWebhook: 'https://hooks.slack.com/x' }).split('\n');

    const at = lines.indexOf('  delivery: markdown, slack');
    expect(lines[at + 1]).toBe(`  saved to: ${FOLDER} (one folder per week)`);
  });

  it('never prints the password or the webhook', () => {
    const text = summaryOf({
      ...BASE,
      email: { delivery: undefined, password: 'smtp-secret' },
      slackWebhook: 'https://hooks.slack.com/services/T000/B000/hook-secret',
    });

    expect(text).not.toContain('smtp-secret');
    expect(text).not.toContain('hook-secret');
  });

  it('notes that quality is unmeasured, and how to switch, when quality was chosen', () => {
    const text = summaryOf({ ...BASE, profile: 'quality' });

    expect(text).toContain(
      `  note:     ${QUALITY_UNMEASURED}; set "profile" to "light" in ${CONFIG_PATH} for a shorter week.\n`,
    );
    expect(text).toMatch(
      /note:.*quality is not measured end to end yet.*input guard alone took about 1 h/,
    );
  });

  it.each(['light', 'fast'] as const)('has no such note for %s', (profile) => {
    expect(summaryOf({ ...BASE, profile })).not.toMatch(/not measured yet|note:/);
  });
});

describe('dockerNextSteps', () => {
  const NEXT =
    'Next: "docker compose up -d" starts the weekly schedule. Run "digest doctor" first to check the setup.\n';

  it('points to docker compose and doctor for a real time zone', () => {
    expect(dockerNextSteps('Europe/Berlin')).toBe(`\n${NEXT}`);
  });

  it.each(['UTC', 'Etc/UTC'])(
    'warns that the schedule runs on %s and how to change it, before the next steps',
    (zone) => {
      const text = dockerNextSteps(zone);

      expect(text).toBe(
        `\nThe schedule runs on ${zone}. For your local time, set schedule.timeZone in digest.config.json (for example "Europe/Berlin").\n\n${NEXT}`,
      );
    },
  );
});
