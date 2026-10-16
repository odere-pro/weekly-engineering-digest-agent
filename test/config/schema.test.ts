import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, EnvSchema, SECRET_KEYS, SecretsSchema } from '../../src/config/schema.js';
import { makeConfig } from '../builders.js';

describe('config schema', () => {
  it('fills the spec defaults', () => {
    const config = makeConfig();
    expect(config).toMatchObject({
      profile: 'quality',
      windowDays: 7,
      topN: 5,
      dedupeWeeks: 4,
      keepWeeks: 12,
      schedule: { cron: '45 7 * * 1', timeZone: 'Europe/Berlin' },
      delivery: { markdown: { dir: 'data/digests' } },
      guards: {
        input: { enabled: true, mode: 'any', checks: { clefPolicy: true, graniteRisk: true } },
        output: {
          enabled: true,
          mode: 'any',
          checks: { graniteGroundedness: true, clefRubric: true },
        },
      },
      models: { retries: 2 },
    });
  });

  it('rejects keepWeeks below dedupeWeeks, since pruned weeks leave dedupe', () => {
    const base = {
      focusAreas: ['a'],
      sources: [{ id: 'x', kind: 'rss', url: 'https://example.com/feed' }],
    } as const;
    const result = ConfigSchema.safeParse({ ...base, keepWeeks: 2, dedupeWeeks: 4 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['keepWeeks']);
    expect(ConfigSchema.safeParse({ ...base, keepWeeks: 4, dedupeWeeks: 4 }).success).toBe(true);
  });

  it('accepts a think setting per role', () => {
    const config = makeConfig({ models: { think: { guardRisk: false, write: 'low' } } });
    expect(config.models.think).toEqual({ guardRisk: false, write: 'low' });
  });

  it('defaults the time zone to the local one', () => {
    const config = ConfigSchema.parse({
      focusAreas: ['a'],
      sources: [{ id: 'x', kind: 'rss', url: 'https://example.com/feed' }],
    });
    expect(config.schedule.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('rejects duplicate source ids and topN outside 3-5', () => {
    const source = { id: 'x', kind: 'rss', url: 'https://example.com/feed' } as const;
    expect(ConfigSchema.safeParse({ focusAreas: ['a'], sources: [source, source] }).success).toBe(
      false,
    );
    expect(ConfigSchema.safeParse({ focusAreas: ['a'], sources: [source], topN: 6 }).success).toBe(
      false,
    );
  });

  it('limits focus areas to 25 unique entries', () => {
    const source = { id: 'x', kind: 'rss', url: 'https://example.com/feed' } as const;
    const areas = Array.from({ length: 26 }, (_, i) => `area ${i}`);
    expect(ConfigSchema.safeParse({ focusAreas: areas, sources: [source] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ focusAreas: ['AI', 'ai'], sources: [source] }).success).toBe(
      false,
    );
    expect(
      ConfigSchema.safeParse({ focusAreas: areas.slice(0, 25), sources: [source] }).success,
    ).toBe(true);
  });

  it('requires TLS for email delivery unless switched off', () => {
    const email = {
      host: 'smtp.example.com',
      user: 'u',
      from: 'a@example.com',
      to: ['b@example.com'],
    };
    expect(makeConfig({ delivery: { email } }).delivery.email?.requireTLS).toBe(true);
    expect(
      makeConfig({ delivery: { email: { ...email, requireTLS: false } } }).delivery.email
        ?.requireTLS,
    ).toBe(false);
  });

  it('parses digest.config.example.json', () => {
    const raw: unknown = JSON.parse(readFileSync('digest.config.example.json', 'utf8'));
    expect(ConfigSchema.safeParse(raw).success).toBe(true);
  });

  it('separates secrets from env settings', () => {
    expect(SECRET_KEYS).toEqual(['SMTP_PASSWORD', 'SLACK_WEBHOOK_URL', 'GITHUB_TOKEN']);
    expect(SecretsSchema.parse({})).toEqual({});
    expect(EnvSchema.parse({})).toEqual({
      OLLAMA_URL: 'http://localhost:11434',
      LOG_LEVEL: 'info',
    });
  });
});
