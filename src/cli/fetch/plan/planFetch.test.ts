import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Source } from '../../../domain/schemas';
import { fixedClock } from '../../../../test/fakes';
import { makeConfig } from '../../../../test/builders';
import type { ConfigInput, Secrets } from '../../../config/schema';
import { REPO, RSS, TOKEN, serving } from '../__fixtures__/fetchHarness';
import { planFetch } from './planFetch';
import type { Plan, PlanEnv, PlanOptions } from './types';

const NOW = '2026-10-13T00:00:00Z';
const DAY_MS = 86_400_000;
const ATOM: Source = { id: 'example-atom', kind: 'rss', url: 'https://example.org/feed.xml' };
const redact = (text: string): string => text.replaceAll('hunter2', '[redacted]');

function plan(
  options: PlanOptions = {},
  days?: number,
  config: Partial<ConfigInput> = {},
  secrets: Secrets = {},
  env: Partial<PlanEnv> = {},
): Plan {
  const full: PlanEnv = {
    clock: fixedClock(NOW),
    cwd: '/work/here',
    fetch: serving({}).fetch,
    sourceTimeoutMs: 5_000,
    ...env,
  };
  return planFetch(
    options,
    days,
    { config: makeConfig({ dataDir: 'dist-data', ...config }), secrets },
    full,
    redact,
  );
}

describe('planFetch: sources', () => {
  it('takes every source of the config when none are named', () => {
    expect(plan({}, undefined, { sources: [RSS, REPO] }).sources).toEqual([RSS, REPO]);
  });

  it('takes the named ones, and fails on an unknown id', () => {
    const chosen = plan({ source: ['example-atom'] }, undefined, { sources: [RSS, ATOM] });

    expect(chosen.sources).toEqual([ATOM]);
    expect(() => plan({ source: ['nope'] })).toThrow(/Unknown source: nope/);
  });
});

describe('planFetch: where to write', () => {
  it("defaults to the config's data folder, resolved against the working directory", () => {
    expect(plan().root).toBe(resolve('/work/here', 'dist-data'));
  });

  it('keeps an absolute data folder as it is', () => {
    expect(plan({}, undefined, { dataDir: '/var/digest' }).root).toBe('/var/digest');
  });

  it('prefers --out, resolved against the working directory', () => {
    expect(plan({ out: 'elsewhere' }).root).toBe(join('/work/here', 'elsewhere'));
  });

  it('trims --out', () => {
    expect(plan({ out: '  elsewhere  ' }).root).toBe(join('/work/here', 'elsewhere'));
  });

  it.each(['', '   '])('treats a blank --out (%j) as no --out', (out) => {
    expect(plan({ out }).root).toBe(resolve('/work/here', 'dist-data'));
  });

  it("names the day in the schedule's time zone", () => {
    const late = { clock: fixedClock('2026-10-13T22:30:00Z') };

    expect(plan({}, undefined, {}, {}, late).day).toBe('2026-10-14');
    expect(plan({}, undefined, { schedule: { timeZone: 'UTC' } }, {}, late).day).toBe('2026-10-13');
  });
});

describe('planFetch: the window', () => {
  it('uses the configured days by default', () => {
    const result = plan({}, undefined, { windowDays: 3 });

    expect(result.windowDays).toBe(3);
    expect(result.run.window.until).toEqual(new Date(NOW));
    expect(result.run.window.since).toEqual(new Date(Date.parse(NOW) - 3 * DAY_MS));
  });

  it('lets --since win', () => {
    const result = plan({}, 30, { windowDays: 3 });

    expect(result.windowDays).toBe(30);
    expect(result.run.window.since).toEqual(new Date('2026-09-13T00:00:00Z'));
  });

  it('starts at the time the clock gave, read once', () => {
    let reads = 0;
    const clock = { now: () => new Date(Date.parse(NOW) + reads++) };

    const result = plan({}, undefined, {}, {}, { clock });

    expect(result.startedAt).toEqual(new Date(NOW));
    expect(reads).toBe(1);
  });
});

describe('planFetch: the run', () => {
  it('carries the limits of the config and of the deps', () => {
    const clock = fixedClock(NOW);

    const { run } = plan(
      {},
      undefined,
      { maxItemsPerSource: 9 },
      {},
      { clock, sourceTimeoutMs: 123 },
    );

    expect(run.maxItemsPerSource).toBe(9);
    expect(run.timeoutMs).toBe(123);
    expect(run.clock).toBe(clock);
  });

  it('carries the redactor it was given', () => {
    expect(plan().run.redact('pass hunter2')).toBe('pass [redacted]');
  });

  it('builds a fetcher for each kind of source, with a recorder of its own', () => {
    const first = plan().run;
    const second = plan().run;

    expect(Object.keys(first.fetchers).sort()).toEqual(['github', 'rss']);
    expect(first.recorder).not.toBe(second.recorder);
  });

  it('reads GitHub through the REST API when the secrets hold a token', async () => {
    const served = serving({});
    const { run } = plan({}, undefined, {}, { GITHUB_TOKEN: TOKEN }, { fetch: served.fetch });

    await run.fetchers.github
      .fetch(REPO, { since: new Date(NOW), until: new Date(NOW), maxItems: 1 })
      .catch(() => undefined);

    expect(served.calls[0]?.url).toContain('api.github.com');
  });
});
