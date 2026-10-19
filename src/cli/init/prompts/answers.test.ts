import { describe, expect, it } from 'vitest';
import { DEFAULT_FOCUS_AREAS } from '../../../sources/defaultSources';
import {
  EMAIL_RULES,
  harness,
  selectionValidatorFor,
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
      'Deliver',
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
        [/Deliver the digest/, ['markdown', 'email', 'slack']],
        ...EMAIL_RULES.slice(1),
        ...SLACK_RULES.slice(1),
      ],
    });

    expect(answers.email).toBeDefined();
    expect(answers.slackWebhook).toBeDefined();
  });

  describe('the channels question', () => {
    const channelsOf = (calls: Awaited<ReturnType<typeof askWith>>['calls']) => {
      const call = calls.find((c) => /Deliver the digest/.test(c.message));
      if (!call) throw new Error('the channels question was not asked');
      return call;
    };

    it('lists saving locally first, ticked, with the folder it writes to', async () => {
      const { calls } = await askWith();

      expect(channelsOf(calls).options.choices).toEqual([
        {
          name: 'Save locally (Markdown and HTML): /work/dist/2026-10-19/digest/',
          value: 'markdown',
          checked: true,
        },
        { name: 'Email (SMTP)', value: 'email' },
        { name: 'Slack (incoming webhook)', value: 'slack' },
      ]);
    });

    it('leaves email and Slack unticked, so Enter alone adds no channel', async () => {
      const { answers, calls } = await askWith();

      const ticked = channelsOf(calls).options.choices?.filter((c) => c.checked);
      expect(ticked?.map((c) => c.value)).toEqual(['markdown']);
      expect(answers.email).toBeUndefined();
      expect(answers.slackWebhook).toBeUndefined();
    });

    it('no longer says the Markdown files are an extra', async () => {
      const { calls } = await askWith();

      expect(channelsOf(calls).message).not.toMatch(/Also|always written/);
    });

    it('names the week folder of the clock, in the schedule time zone the user picked', async () => {
      const { calls } = await askWith({
        now: '2026-10-18T23:30:00Z',
        rules: [[/Time zone/, 'UTC']],
      });

      expect(channelsOf(calls).options.choices?.[0]?.name).toBe(
        'Save locally (Markdown and HTML): /work/dist/2026-10-12/digest/',
      );
    });

    it('names the folder digest runs from', async () => {
      const { calls } = await askWith({ cwd: '/home/ana/digest' });

      expect(channelsOf(calls).options.choices?.[0]?.name).toContain(
        ': /home/ana/digest/dist/2026-10-19/digest/',
      );
    });

    it('says in Docker that the folder is ./dist on the host', async () => {
      const { calls } = await askWith(
        { inDocker: true, cwd: '/app' },
        { inDocker: true, hostOs: 'darwin' },
      );

      expect(channelsOf(calls).options.choices?.[0]?.name).toBe(
        'Save locally (Markdown and HTML): ./dist/2026-10-19/digest/ on the host',
      );
    });

    it('refuses an unticked "save locally" with the reason, and accepts it ticked', async () => {
      const { calls } = await askWith();
      const validate = selectionValidatorFor(calls, /Deliver the digest/);

      expect(validate([{ value: 'email' }])).toMatch(/always on/);
      expect(validate([])).toMatch(/always on/);
      expect(validate([{ value: 'markdown' }])).toBe(true);
      expect(validate([{ value: 'markdown' }, { value: 'email' }, { value: 'slack' }])).toBe(true);
    });

    it('keeps the user from finishing without it', async () => {
      await expect(askWith({ rules: [[/Deliver the digest/, ['email']]] })).rejects.toThrow(
        /always on/,
      );
    });
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
