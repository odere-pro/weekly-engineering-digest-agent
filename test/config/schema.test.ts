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
