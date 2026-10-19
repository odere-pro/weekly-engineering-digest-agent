import { describe, expect, it } from 'vitest';
import { DEFAULT_FOCUS_AREAS } from '../../../sources/defaultSources';
import {
  EMAIL_RULES,
  harness,
  SLACK_RULES,
  type HarnessOptions,
} from '../__fixtures__/initHarness';
import type { Host } from '../types';
import { askAnswers, defaultAnswers } from './answers';

const PLAIN_HOST: Host = { inDocker: false, hostOs: undefined };

async function askWith(options: HarnessOptions = {}, host: Host = PLAIN_HOST) {
  const h = harness(options);
  const answers = await askAnswers(h.io, host, 'light');
  return { answers, calls: h.calls };
}

describe('askAnswers', () => {
  it('asks focus areas, profile, time zone and delivery channels, in that order', async () => {
    const { calls } = await askWith();

    expect(calls.map((c) => c.message.split(/[ (]/)[0])).toEqual([
      'Focus',
      'Other',
      'Model',
      'Time',
      'Also',
    ]);
  });

  it('answers with the defaults and Markdown only when the user just presses Enter', async () => {
    const { answers } = await askWith({ timeZone: 'Asia/Tokyo' });

    expect(answers).toEqual({
      profile: 'light',
      timeZone: 'Asia/Tokyo',
      focusAreas: [...DEFAULT_FOCUS_AREAS],
    });
    expect('email' in answers).toBe(false);
    expect('slackWebhook' in answers).toBe(false);
  });

  it('adds the email answers when email is picked, and asks nothing about Slack', async () => {
    const { answers, calls } = await askWith({ rules: EMAIL_RULES });

    expect(answers.email?.delivery?.host).toBe('smtp.example.com');
    expect(answers.email?.password).toBe('smtp-secret');
    expect(answers.slackWebhook).toBeUndefined();
    expect(calls.some((c) => /Slack/.test(c.message))).toBe(false);
  });

  it('adds the Slack webhook when Slack is picked, and asks nothing about email', async () => {
    const { answers, calls } = await askWith({ rules: SLACK_RULES });

    expect(answers.slackWebhook).toBe('https://hooks.slack.com/services/T000/B000/hook-secret');
    expect(answers.email).toBeUndefined();
    expect(calls.some((c) => /SMTP/.test(c.message))).toBe(false);
  });

  it('supports email and Slack together', async () => {
    const { answers } = await askWith({
      rules: [
        [/Also deliver/, ['email', 'slack']],
        ...EMAIL_RULES.slice(1),
        ...SLACK_RULES.slice(1),
      ],
    });

    expect(answers.email).toBeDefined();
    expect(answers.slackWebhook).toBeDefined();
  });

  it('says that Markdown files are always written, so it is not a choice', async () => {
    const { calls } = await askWith();

    const channels = calls.find((c) => /Also deliver/.test(c.message));
    expect(channels?.message).toContain('Markdown files are always written');
    expect(channels?.options.choices?.map((c) => c.value)).toEqual(['email', 'slack']);
  });

  it('writes the profile that was chosen', async () => {
    const { answers } = await askWith({ rules: [[/Model profile/, 'fast']] });

    expect(answers.profile).toBe('fast');
  });

  it('lets the host shape the questions: a container on UTC is told so', async () => {
    const { calls } = await askWith(
      { inDocker: true, timeZone: 'UTC' },
      { inDocker: true, hostOs: 'linux' },
    );

    expect(calls.find((c) => /Time zone/.test(c.message))?.message).toContain('TZ');
  });
});

describe('defaultAnswers', () => {
  it('uses the recommended profile, the zone this process runs in and the default focus areas', () => {
    const { io } = harness({ timeZone: 'America/Chicago' });

    expect(defaultAnswers(io, 'light')).toEqual({
      profile: 'light',
      timeZone: 'America/Chicago',
      focusAreas: [...DEFAULT_FOCUS_AREAS],
    });
  });

  it('takes whatever profile it is told to recommend', () => {
    expect(defaultAnswers(harness().io, 'fast').profile).toBe('fast');
  });

  it('asks nothing', () => {
    const h = harness();

    defaultAnswers(h.io, 'light');

    expect(h.calls).toEqual([]);
  });

  it('gives each call its own focus areas, so a caller cannot change the defaults', () => {
    const { io } = harness();

    defaultAnswers(io, 'light').focusAreas.push('extra');

    expect(defaultAnswers(io, 'light').focusAreas).toEqual([...DEFAULT_FOCUS_AREAS]);
  });
});
