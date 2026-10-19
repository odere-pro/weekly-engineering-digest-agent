import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../../config/schema';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../../sources/defaultSources';
import type { Answers } from '../types';
import { buildConfigInput, toJson, validatedConfig } from './configFile';

const BASE: Answers = {
  profile: 'light',
  timeZone: 'Europe/Berlin',
  focusAreas: ['AI models and tooling'],
};
const EMAIL = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTLS: true,
  user: 'digest@example.com',
  from: 'digest@example.com',
  to: ['ana@example.com'],
};

describe('buildConfigInput', () => {
  it('has the profile, focus areas, time zone and the default sources, and no delivery', () => {
    const input = buildConfigInput(BASE);

    expect(input).toEqual({
      profile: 'light',
      focusAreas: ['AI models and tooling'],
      schedule: { timeZone: 'Europe/Berlin' },
      sources: [...DEFAULT_SOURCES],
    });
    expect('delivery' in input).toBe(false);
  });

  it('puts the email fields in the config but not the password', () => {
    const input = buildConfigInput({
      ...BASE,
      email: { delivery: EMAIL, password: 'smtp-secret' },
    });

    expect(input.delivery).toEqual({ email: EMAIL });
    expect(JSON.stringify(input)).not.toContain('smtp-secret');
  });

  it('turns Slack on with the flag only, never the webhook', () => {
    const input = buildConfigInput({ ...BASE, slackWebhook: 'https://hooks.slack.com/services/x' });

    expect(input.delivery).toEqual({ slack: { enabled: true } });
    expect(JSON.stringify(input)).not.toContain('hooks.slack.com');
  });

  it('carries email and Slack together', () => {
    const input = buildConfigInput({
      ...BASE,
      email: { delivery: EMAIL, password: 'p' },
      slackWebhook: 'https://hooks.slack.com/services/x',
    });

    expect(Object.keys(input.delivery ?? {}).sort()).toEqual(['email', 'slack']);
  });

  it('gives each call its own sources array, so a caller cannot change the defaults', () => {
    const first = buildConfigInput(BASE);
    first.sources.pop();

    expect(buildConfigInput(BASE).sources).toHaveLength(DEFAULT_SOURCES.length);
  });
});

describe('validatedConfig', () => {
  it('returns the parsed config with the schema defaults filled in', () => {
    const config = validatedConfig(
      buildConfigInput({ ...BASE, focusAreas: [...DEFAULT_FOCUS_AREAS] }),
    );

    expect(config.schedule.cron).toBe('45 7 * * 1');
    expect(config.profile).toBe('light');
  });

  it('refuses answers that do not make a config, naming the field and writing nothing', () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `area ${String(i)}`);

    expect(() => validatedConfig(buildConfigInput({ ...BASE, focusAreas: tooMany }))).toThrow(
      /do not make a valid config, nothing was written\.\nfocusAreas/,
    );
  });
});

describe('toJson', () => {
  it('prints two-space JSON that ends with a newline', () => {
    const input = buildConfigInput(BASE);

    const text = toJson(input);

    expect(text).toBe(`${JSON.stringify(input, null, 2)}\n`);
    expect(text.startsWith('{\n  "profile": "light",\n  "focusAreas": [\n    "AI models')).toBe(
      true,
    );
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('prints a config the schema accepts', () => {
    const text = toJson(buildConfigInput({ ...BASE, focusAreas: [...DEFAULT_FOCUS_AREAS] }));

    expect(ConfigSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });
});
