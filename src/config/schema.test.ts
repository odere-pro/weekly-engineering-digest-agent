import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, EnvSchema, SECRET_KEYS, SecretsSchema } from './schema';
import { makeConfig } from '../../test/builders';

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
      delivery: { markdown: {} },
      guards: {
        input: {
          enabled: true,
          mode: 'any',
          checks: { ruleInjection: true, clefPolicy: true, graniteRisk: true },
        },
        output: {
          enabled: true,
          mode: 'any',
          checks: { graniteGroundedness: true, clefRubric: true },
        },
      },
      models: { retries: 2, rescoreWithWriter: false, seed: 42 },
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

  it('puts everything the project produces in dist by default', () => {
    const config = ConfigSchema.parse({
      focusAreas: ['a'],
      sources: [{ id: 'x', kind: 'rss', url: 'https://example.com/feed' }],
    });
    expect(config.dataDir).toBe('dist');
  });

  it('writes the Markdown channel into the week folder unless a dir is set', () => {
    expect(makeConfig().delivery.markdown.dir).toBeUndefined();
    expect(makeConfig({ delivery: { markdown: { dir: 'out' } } }).delivery.markdown.dir).toBe(
      'out',
    );
  });

  it('refuses the source id "digest", the name of the week digest folder', () => {
    const result = ConfigSchema.safeParse({
      focusAreas: ['a'],
      sources: [{ id: 'digest', kind: 'rss', url: 'https://example.com/feed' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sources', 0, 'id']);
    expect(result.error?.issues[0]?.message).toMatch(/reserved/);
  });

  describe('source URLs', () => {
    const base = { focusAreas: ['a'] } as const;
    const withUrl = (url: string): ReturnType<typeof ConfigSchema.safeParse> =>
      ConfigSchema.safeParse({ ...base, sources: [{ id: 'x', kind: 'rss', url }] });

    it.each([
      'https://alice:hunter2@example.com/feed.xml?token=abc123',
      'https://alice@example.com/feed.xml',
      'https://:hunter2@example.com/feed.xml',
      'http://alice:hunter2@example.com/',
    ])('rejects %s, pointing at the field without echoing the URL', (url) => {
      const result = withUrl(url);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
      expect(result.error?.issues[0]?.path).toEqual(['sources', 0, 'url']);
      expect(result.error?.issues[0]?.message).toMatch(/username or password/);
      expect(JSON.stringify(result.error?.issues)).not.toMatch(
        /alice|hunter2|abc123|example\.com|feed\.xml/,
      );
    });

    it('names the source that has credentials when only one of several does', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        sources: [
          { id: 'ok', kind: 'rss', url: 'https://example.com/feed.xml' },
          { id: 'bad', kind: 'github', url: 'https://alice:hunter2@github.com/acme/tool' },
        ],
      });

      expect(result.error?.issues.map((issue) => issue.path)).toEqual([['sources', 1, 'url']]);
    });

    it.each([
      'https://example.com/feed?contact=alice@example.org',
      'https://example.com/@alice/feed.xml',
      'https://example.com/feed.xml#alice:hunter2@x',
      'https://example.com:8443/feed.xml',
    ])('accepts %s, whose "@" or ":" is not credentials', (url) => {
      expect(withUrl(url).success).toBe(true);
    });

    it('still reports a URL that is not a URL as one error, not two', () => {
      const result = withUrl('not a url');

      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
    });
  });

  it('rejects a writer listed twice', () => {
    expect(() => makeConfig({ models: { writers: ['gemma4:31b', 'gemma4:31b'] } })).toThrow(
      /writers must be unique/,
    );
  });

  it('accepts a think setting per role', () => {
    const config = makeConfig({ models: { think: { guardRisk: false, write: 'low' } } });
    expect(config.models.think).toEqual({ guardRisk: false, write: 'low' });
  });

  it('accepts the writer rescoring flag and keeps it off by default', () => {
    expect(makeConfig().models.rescoreWithWriter).toBe(false);
    expect(makeConfig({ models: { rescoreWithWriter: true } }).models.rescoreWithWriter).toBe(true);
    expect(() => makeConfig({ models: { rescoreWithWriter: 'yes' as never } })).toThrow();
  });

  it('accepts a sampling seed and defaults it to 42', () => {
    expect(makeConfig().models.seed).toBe(42);
    expect(makeConfig({ models: { seed: 7 } }).models.seed).toBe(7);
    expect(() => makeConfig({ models: { seed: -1 } })).toThrow();
    expect(() => makeConfig({ models: { seed: 1.5 } })).toThrow();
  });

  it('accepts a temperature per role within 0..2 and none by default', () => {
    expect(makeConfig().models.temperature).toBeUndefined();
    const config = makeConfig({ models: { temperature: { write: 0.2, classify: 0 } } });
    expect(config.models.temperature).toEqual({ write: 0.2, classify: 0 });
    expect(() => makeConfig({ models: { temperature: { write: 2.5 } } })).toThrow();
    expect(() => makeConfig({ models: { temperature: { chat: 0.1 } as never } })).toThrow();
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

  describe('SLACK_WEBHOOK_URL', () => {
    const parse = (value: string) => SecretsSchema.safeParse({ SLACK_WEBHOOK_URL: value });

    it('accepts an https webhook', () => {
      expect(parse('https://hooks.slack.com/services/T000/B000/XXXX').success).toBe(true);
    });

    it('rejects an http webhook, which would send the secret path in clear text', () => {
      expect(parse('http://hooks.slack.com/services/T000/B000/XXXX').success).toBe(false);
    });

    it('rejects other schemes and text that is not a URL', () => {
      expect(parse('ftp://hooks.slack.com/services/T000/B000/XXXX').success).toBe(false);
      expect(parse('not-a-url').success).toBe(false);
    });

    it('does not echo the rejected value in the error', () => {
      const result = parse('http://hooks.slack.com/services/T000/B000/s3cr3t');
      expect(JSON.stringify(result.error?.issues)).not.toContain('s3cr3t');
    });

    it('stays optional', () => {
      expect(SecretsSchema.safeParse({}).success).toBe(true);
    });
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
