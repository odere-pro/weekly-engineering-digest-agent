import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errnoError, resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { checkUnknownKeys, findUnknownKeys } from './unknownKeys';

const CONFIG_PATH = '/srv/digest/digest.config.json';

/** The smallest config the schema accepts, with `extra` merged over it (shallow). */
function configJson(extra: Record<string, unknown> = {}): unknown {
  return {
    focusAreas: ['AI models and tooling'],
    sources: [{ id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' }],
    ...extra,
  };
}

describe('findUnknownKeys with the config schema', () => {
  it('finds nothing in a config that only uses known keys, nested ones included', () => {
    const json = configJson({
      topN: 4,
      schedule: { cron: '45 7 * * 1', timeZone: 'Europe/Berlin' },
      delivery: {
        markdown: { dir: 'out' },
        email: {
          host: 'smtp.example.com',
          user: 'a',
          from: 'a@example.com',
          to: ['b@example.com'],
        },
        slack: { enabled: true },
      },
      guards: { input: { enabled: true, checks: { ruleInjection: false } } },
      thresholds: { minRelevance: 2 },
      models: { timeoutsMs: { classify: 5000 }, think: { write: 'low' }, seed: 1 },
    });

    expect(findUnknownKeys(json)).toEqual([]);
  });

  it.each([
    ['a top-level key', { topn: 3 }, 'topn', 'topN'],
    ['a key in a wrapped object', { delivery: { emial: {} } }, 'delivery.emial', 'delivery.email'],
    [
      'a key in an optional object',
      { delivery: { slack: { enable: true } } },
      'delivery.slack.enable',
      'delivery.slack.enabled',
    ],
    [
      'a threshold name',
      { thresholds: { minRelevence: 1 } },
      'thresholds.minRelevence',
      'thresholds.minRelevance',
    ],
    [
      'a key two levels down in a defaulted object',
      { guards: { input: { checks: { ruleInjectin: false } } } },
      'guards.input.checks.ruleInjectin',
      'guards.input.checks.ruleInjection',
    ],
    ['a key that differs only in case', { TopN: 3 }, 'TopN', 'topN'],
    ['a missing letter', { windowDay: 3 }, 'windowDay', 'windowDays'],
  ])('finds %s and suggests the key next to it', (_label, extra, path, suggestion) => {
    expect(findUnknownKeys(configJson(extra))).toEqual([{ path, suggestion }]);
  });

  it('finds a typo in each entry of a list of objects, naming the entry', () => {
    const json = configJson({
      sources: [
        { id: 'a', kind: 'rss', url: 'https://example.com/a.xml' },
        { id: 'b', kind: 'rss', url: 'https://example.com/b.xml', urll: 'x' },
      ],
    });

    expect(findUnknownKeys(json)).toEqual([
      { path: 'sources[1].urll', suggestion: 'sources[1].url' },
    ]);
  });

  it('lists every unknown key, in file order', () => {
    const found = findUnknownKeys(configJson({ zzzzzzzz: 1, topn: 2, schedule: { cro: 'x' } }));

    expect(found.map((key) => key.path)).toEqual(['zzzzzzzz', 'topn', 'schedule.cro']);
  });

  it('gives no suggestion when no known key is within two edits', () => {
    expect(findUnknownKeys(configJson({ banana: 1 }))).toEqual([{ path: 'banana' }]);
  });

  it('reads a swapped pair of letters as one edit, so one more typo is still within two', () => {
    expect(findUnknownKeys(configJson({ delivery: { emials: {} } }))).toEqual([
      { path: 'delivery.emials', suggestion: 'delivery.email' },
    ]);
  });

  it('does not look inside a key that is a value of a record', () => {
    const json = configJson({ models: { timeoutsMs: { classify: 1000 } } });

    expect(findUnknownKeys(json)).toEqual([]);
  });

  it('reports a key named __proto__, which JSON.parse makes an own property', () => {
    const json = JSON.parse('{"__proto__": 1}') as unknown;

    expect(findUnknownKeys(json)).toEqual([{ path: '__proto__' }]);
  });

  it('says nothing where the schema expects an object but the file has something else', () => {
    // The loader has refused such a file already; this only has to not throw.
    expect(findUnknownKeys(configJson({ delivery: 5, schedule: null, guards: [] }))).toEqual([]);
    expect(findUnknownKeys(null)).toEqual([]);
    expect(findUnknownKeys('text')).toEqual([]);
  });
});

describe('findUnknownKeys with other shapes', () => {
  const find = (schema: z.ZodType, value: unknown) => findUnknownKeys(value, schema);

  it('suggests nothing when two known keys are equally close', () => {
    const schema = z.object({ color: z.string(), colon: z.string() });

    expect(find(schema, { colos: 'x' })).toEqual([{ path: 'colos' }]);
  });

  it('suggests nothing when an edit would replace the whole key', () => {
    const schema = z.object({ id: z.string() });

    expect(find(schema, { ab: 1 })).toEqual([{ path: 'ab' }]);
    expect(find(schema, { ix: 1 })).toEqual([{ path: 'ix', suggestion: 'id' }]);
  });

  it('leaves an object that accepts other keys alone, and one that rejects them', () => {
    const loose = z.looseObject({ a: z.string() });
    const strict = z.strictObject({ a: z.string() });

    expect(find(loose, { a: 'x', b: 1 })).toEqual([]);
    expect(find(strict, { a: 'x', b: 1 })).toEqual([]);
  });

  it('leaves the values of a record alone', () => {
    const schema = z.object({ byName: z.record(z.string(), z.object({ n: z.number() })) });

    expect(find(schema, { byName: { x: { m: 1 } } })).toEqual([]);
  });

  it.each([
    ['nullable', z.object({ inner: z.object({ a: z.string() }).nullable() })],
    ['readonly', z.object({ inner: z.object({ a: z.string() }).readonly() })],
    ['catch', z.object({ inner: z.object({ a: z.string() }).catch({ a: 'x' }) })],
    ['piped', z.object({ inner: z.object({ a: z.string() }).pipe(z.object({ a: z.string() })) })],
    [
      'optional default',
      z.object({ inner: z.object({ a: z.string() }).optional().default({ a: 'x' }) }),
    ],
  ])('looks through a %s wrapper', (_label, schema) => {
    expect(find(schema, { inner: { b: 1 } })).toEqual([{ path: 'inner.b' }]);
  });

  it('walks nested lists', () => {
    const schema = z.object({ rows: z.array(z.array(z.object({ a: z.string() }))) });

    expect(find(schema, { rows: [[{ a: 'x' }], [{ a: 'x', b: 1 }]] })).toEqual([
      { path: 'rows[1][0].b' },
    ]);
  });
});

describe('checkUnknownKeys', () => {
  const readerOf = (text: string) => ({ readFile: async () => text });

  it('returns one warning per unknown key, with the path and a "did you mean" fix', async () => {
    const text = JSON.stringify(configJson({ topn: 3, delivery: { emial: {} } }));

    const results = await checkUnknownKeys(CONFIG_PATH, readerOf(text));

    expect(results).toEqual([
      {
        severity: 'warn',
        label: 'config key "topn"',
        message: 'not a setting, so a run ignores it and the default applies; did you mean "topN"?',
        fix: 'rename or remove it in digest.config.json; every key is listed in docs/reference/config-keys.md',
      },
      {
        severity: 'warn',
        label: 'config key "delivery.emial"',
        message:
          'not a setting, so a run ignores it and the default applies; did you mean "delivery.email"?',
        fix: 'rename or remove it in digest.config.json; every key is listed in docs/reference/config-keys.md',
      },
    ]);
  });

  it('leaves out "did you mean" when no key is close', async () => {
    const [result] = await checkUnknownKeys(
      CONFIG_PATH,
      readerOf(JSON.stringify(configJson({ banana: 1 }))),
    );

    expect(result?.message).toBe('not a setting, so a run ignores it and the default applies');
  });

  it('reads the file the loader read', async () => {
    const asked: string[] = [];

    await checkUnknownKeys(CONFIG_PATH, {
      readFile: async (path) => {
        asked.push(path);
        return '{}';
      },
    });

    expect(asked).toEqual([CONFIG_PATH]);
  });

  it('returns nothing for a clean file', async () => {
    expect(await checkUnknownKeys(CONFIG_PATH, readerOf(JSON.stringify(configJson())))).toEqual([]);
  });

  it('returns nothing when the file cannot be read again or is not JSON: the loader reported that', async () => {
    const unreadable = { readFile: async () => Promise.reject(errnoError('ENOENT')) };

    expect(await checkUnknownKeys(CONFIG_PATH, unreadable)).toEqual([]);
    expect(await checkUnknownKeys(CONFIG_PATH, readerOf('{ not json'))).toEqual([]);
  });

  it('keeps a hostile key on one printable line, cut to a readable length', async () => {
    const key = `a\nb‮c${'x'.repeat(200)}`;
    const text = JSON.stringify(configJson({ [key]: 1 }));

    const [result] = await checkUnknownKeys(CONFIG_PATH, readerOf(text));

    expect(result?.label).not.toMatch(/[\n‮]/);
    expect(result?.label.length).toBeLessThan(100);
  });
});

describe('doctorCommand unknown keys', () => {
  it('prints a ! with a fix for a misspelled key, and still exits 0', async () => {
    const { text, code } = await runDoctor({
      configText: JSON.stringify(configJson({ topn: 3, delivery: { slack: { enable: true } } })),
    });

    expect(code).toBe(0);
    expect(resultFor(text, '!', 'config key "topn":')).toMatch(/did you mean "topN"\?\n\s+fix: /);
    expect(resultFor(text, '!', 'config key "delivery.slack.enable":')).toContain(
      'did you mean "delivery.slack.enabled"?',
    );
    expect(text).toContain('Doctor: 0 errors, 2 warnings.');
  });

  it('prints no extra line for a config with only known keys', async () => {
    const { text } = await runDoctor();

    expect(text).not.toContain('config key');
    expect(text).toContain('all checks passed');
  });
});
