import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEvalCases, runEval, type EvalDeps } from '../../../evals/runEval.js';
import type { AppHandle } from '../../../src/app/container.js';
import { DEFAULT_SOURCES } from '../../../src/config/defaultSources.js';
import { PROFILES } from '../../../src/config/profiles.js';
import type { DigestDeps } from '../../../src/core/runDigest.js';
import type { Item, Source } from '../../../src/core/schemas.js';
import { collectStep } from '../../../src/core/steps/collect.js';
import { DigestError } from '../../../src/shared/errors.js';
import { makeConfig, makeItem, makeRunRecord } from '../../builders.js';
import {
  FakeModelProvider,
  MemoryRunStore,
  fixedClock,
  noopLogger,
  noopTracer,
} from '../../fakes/index.js';

const WEEK = '2026-W40';
const WEEK_START_MS = Date.parse('2026-09-28T00:00:00Z');
const NOON_MS = 12 * 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Mirrors the recorder: it asks every feed for this many items. */
const RECORDED_PER_SOURCE = 100;
/** The usual per-source cap of a config; a replay must not be limited by it. */
const USUAL_CAP = 20;
const RECORDED_WEEKS_DIR = join(import.meta.dirname, '..', '..', '..', 'evals', 'weeks');
const NONE = { weeks: 0, attacks: 0, grounding: 0, classifier: 0 };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eval-window-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeJson(relativePath: string, data: unknown): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

/** `count` items of one source; `<sourceId>-<n>` is the n-th newest, so n is its rank. */
function feedItems(sourceId: string, count: number): Item[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem({
      id: `${sourceId}-${i + 1}`,
      sourceId,
      publishedAt: new Date(WEEK_START_MS + NOON_MS - i * MINUTE_MS).toISOString(),
    }),
  );
}

const ids = (sourceId: string, ranks: number[]): string[] =>
  ranks.map((rank) => `${sourceId}-${rank}`);

/** Five must-include picks from `sourceId`, then the given must-exclude ids. */
async function writeWeek(
  items: readonly Item[],
  labels: { include: string[]; exclude?: string[] },
): Promise<void> {
  await writeJson(`weeks/${WEEK}/items.json`, items);
  await writeJson(`weeks/${WEEK}/labels.json`, {
    mustInclude: labels.include,
    mustExclude: labels.exclude ?? [],
  });
}

interface Harness {
  deps: EvalDeps;
  close: ReturnType<typeof vi.fn>;
  runDigest: ReturnType<typeof vi.fn>;
  /** What each replay collected, in order: the weeks first, then the repeats. */
  replays: () => Item[][];
  /** What the first replay collected. */
  firstReplay: () => Item[];
}

function makeHarness(sources: Source[]): Harness {
  const collected: Item[][] = [];
  const close = vi.fn(() => Promise.resolve());
  const appDeps: DigestDeps = {
    config: makeConfig({ sources, maxItemsPerSource: USUAL_CAP }),
    profile: PROFILES.quality,
    model: new FakeModelProvider(),
    fetchers: {},
    inputGuards: [],
    outputGuards: [],
    deliveries: [],
    store: new MemoryRunStore(),
    logger: noopLogger,
    tracer: noopTracer,
    clock: fixedClock('2030-01-01T00:00:00Z'),
  };
  const handle: AppHandle = { deps: appDeps, close };
  // The real collect step over the replay's own sources and fetchers: what the pipeline would see.
  const runDigest = vi.fn<EvalDeps['runDigest']>(async (deps, options) => {
    const now = deps.clock.now();
    const { items } = await collectStep(
      {
        sources: deps.config.sources,
        since: new Date(now.getTime() - (options.sinceDays ?? 7) * DAY_MS),
        until: now,
        maxItemsPerSource: deps.config.maxItemsPerSource,
      },
      { fetchers: deps.fetchers, logger: deps.logger, clock: deps.clock, retries: 0 },
    );
    collected.push(items);
    return {
      record: makeRunRecord({ runId: options.weekId ?? WEEK, status: 'dry-run', dryRun: true }),
      exitCode: 0,
    };
  });
  return {
    deps: {
      buildApp: vi.fn(() => Promise.resolve(handle)),
      runDigest,
      clock: fixedClock('2026-10-16T09:00:00Z'),
    },
    close,
    runDigest,
    replays: () => collected,
    firstReplay: () => collected[0] ?? [],
  };
}

const source = (id: string, maxItems?: number): Source => ({
  id,
  kind: 'rss',
  url: `https://example.com/${id}.xml`,
  ...(maxItems === undefined ? {} : { maxItems }),
});

const idsOf = (items: readonly Item[]): string[] => items.map((item) => item.id);

describe('the replay window', () => {
  it('serves a source with its own maxItems past the usual per-source cap', async () => {
    const items = feedItems('wide-feed', 30);
    await writeWeek(items, { include: ids('wide-feed', [1, 2, 3, 25, 30]) });
    const harness = makeHarness([source('wide-feed', 40)]);

    await runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);

    expect(idsOf(harness.firstReplay()).toSorted()).toEqual(idsOf(items).toSorted());
  });

  it('serves everything recorded for a source without a maxItems of its own', async () => {
    const items = [...feedItems('plain-feed', 30), ...feedItems('unlisted-feed', 30)];
    await writeWeek(items, { include: ids('plain-feed', [1, 2, 3, 25, 30]) });
    // plain-feed is on the allowlist with no cap; unlisted-feed is not on it at all.
    const harness = makeHarness([source('plain-feed')]);

    await runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);

    expect(idsOf(harness.firstReplay()).toSorted()).toEqual(idsOf(items).toSorted());
  });

  it('serves up to the recorder cap and no more per source', async () => {
    const items = feedItems('huge-feed', RECORDED_PER_SOURCE + 1);
    await writeWeek(items, { include: ids('huge-feed', [1, 2, 3, 50, RECORDED_PER_SOURCE]) });
    const harness = makeHarness([source('huge-feed')]);

    await runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);

    const seen = idsOf(harness.firstReplay());
    expect(seen).toHaveLength(RECORDED_PER_SOURCE);
    expect(seen).not.toContain(`huge-feed-${RECORDED_PER_SOURCE + 1}`);
  });

  it('breaks a tie on publication time by file order, in the replay and in the label check', async () => {
    const sameMinute = new Date(WEEK_START_MS + NOON_MS).toISOString();
    const items = Array.from({ length: 12 }, (_, i) =>
      makeItem({ id: `tied-${i + 1}`, sourceId: 'tied-feed', publishedAt: sameMinute }),
    );
    // Items 1..10 are served, 11 and 12 are not: the tie keeps the order of items.json.
    await writeWeek(items, {
      include: ids('tied', [1, 2, 3, 4, 10]),
      exclude: ids('tied', [11]),
    });
    const harness = makeHarness([source('tied-feed', 10)]);

    await expect(
      runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps),
    ).rejects.toThrow(/mustExclude tied-11 is item 11 of tied-feed/);

    await writeWeek(items, { include: ids('tied', [1, 2, 3, 4, 10]), exclude: ids('tied', [5]) });
    await runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);
    expect(idsOf(harness.firstReplay())).toEqual(ids('tied', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });

  it("keeps a source's own maxItems when it is smaller than what was recorded", async () => {
    const items = feedItems('tight-feed', 15);
    await writeWeek(items, { include: ids('tight-feed', [1, 2, 3, 4, 5]) });
    const harness = makeHarness([source('tight-feed', 10)]);

    await runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);

    expect(idsOf(harness.firstReplay()).toSorted()).toEqual(
      ids('tight-feed', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).toSorted(),
    );
  });
});

describe('the recorded weeks', () => {
  it('replay every labeled item under the default allowlist', async () => {
    // 2026-W41 mustExclude 59e71a290d09029e is item 26 of aws-whats-new; 2026-W39 mustExclude
    // d2871d486c61275a is item 22 of openai-news. Both sat past the old cap of 20.
    await cp(RECORDED_WEEKS_DIR, join(root, 'weeks'), { recursive: true });
    const harness = makeHarness([...DEFAULT_SOURCES]);

    await runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);

    const { weeks } = await loadEvalCases(root);
    expect(weeks.length).toBeGreaterThan(0);
    weeks.forEach((week, index) => {
      const seen = new Set(idsOf(harness.replays()[index] ?? []));
      const labeled = [...week.labels.mustInclude, ...week.labels.mustExclude];
      expect(labeled.filter((id) => !seen.has(id))).toEqual([]);
    });
  });
});

describe('labels the replay cannot see', () => {
  it('rejects a label past the recorder cap when the cases are loaded', async () => {
    const items = feedItems('big-feed', RECORDED_PER_SOURCE + 1);
    await writeWeek(items, {
      include: ids('big-feed', [1, 2, 3, 4, 5]),
      exclude: ids('big-feed', [RECORDED_PER_SOURCE + 1]),
    });

    const failure = loadEvalCases(root);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow(
      /labels\.json: mustExclude big-feed-101 is item 101 of big-feed, .* newest 100 /,
    );
  });

  it('names a must-include label too', async () => {
    const items = feedItems('big-feed', RECORDED_PER_SOURCE + 1);
    await writeWeek(items, { include: ids('big-feed', [1, 2, 3, 4, RECORDED_PER_SOURCE + 1]) });

    await expect(loadEvalCases(root)).rejects.toThrow(/mustInclude big-feed-101 is item 101/);
  });

  it('accepts a label that is exactly at the recorder cap', async () => {
    const items = feedItems('big-feed', RECORDED_PER_SOURCE + 1);
    await writeWeek(items, { include: ids('big-feed', [1, 2, 3, 4, RECORDED_PER_SOURCE]) });

    const { weeks } = await loadEvalCases(root);

    expect(weeks.map((week) => week.weekId)).toEqual([WEEK]);
  });

  it('rejects a label past the maxItems of its configured source before any replay', async () => {
    const items = feedItems('tight-feed', 15);
    await writeWeek(items, {
      include: ids('tight-feed', [1, 2, 3, 4, 5]),
      exclude: ids('tight-feed', [12]),
    });
    const harness = makeHarness([source('tight-feed', 10)]);

    const failure = runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow(
      /2026-W40.*mustExclude tight-feed-12 is item 12 of tight-feed, .* newest 10 /,
    );
    expect(harness.runDigest).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('accepts a label that is exactly at the maxItems of its configured source', async () => {
    const items = feedItems('tight-feed', 15);
    await writeWeek(items, { include: ids('tight-feed', [1, 2, 3, 4, 10]) });
    const harness = makeHarness([source('tight-feed', 10)]);

    await expect(
      runEval({ profile: 'quality', casesDir: root, minimums: NONE }, harness.deps),
    ).resolves.toMatchObject({ weeks: [WEEK] });
  });
});
