// The replay window (F11): each source is capped exactly as production caps it, `maxItems` of its
// own else the config's `maxItemsPerSource`. A labeled item outside that window is "not visible":
// counted in the detail and left out of recall and leaks.
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDED_ITEMS_PER_SOURCE } from './recordWeeks';
import { loadEvalCases, runEval, type EvalDeps } from './runEval';
import type { AppHandle } from '../src/app/container';
import { DEFAULT_SOURCES } from '../src/sources/defaultSources';
import { PROFILES } from '../src/config/profiles';
import type { DigestDeps } from '../src/digest/runDigest';
import { ItemSchema, type Item, type Source } from '../src/domain/schemas';
import { collectStep } from '../src/sources/collect';
import { makeConfig, makeItem, makeRunRecord } from '../test/builders';
import {
  FakeModelProvider,
  MemoryRunStore,
  fixedClock,
  noopLogger,
  noopTracer,
} from '../test/fakes';

const WEEK = '2026-W40';
const WEEK_START_MS = Date.parse('2026-09-28T00:00:00Z');
const NOON_MS = 12 * 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The config's per-source cap, which production applies to a source with no cap of its own. */
const USUAL_CAP = 20;
const RECORDED_WEEKS_DIR = join(import.meta.dirname, 'weeks');
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
function feedItems(sourceId: string, count: number, weekStartMs = WEEK_START_MS): Item[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem({
      id: `${sourceId}-${i + 1}`,
      sourceId,
      publishedAt: new Date(weekStartMs + NOON_MS - i * MINUTE_MS).toISOString(),
    }),
  );
}

const ids = (sourceId: string, ranks: number[]): string[] =>
  ranks.map((rank) => `${sourceId}-${rank}`);

/** The week's items, with five must-include picks and the given must-exclude ids. */
async function writeWeek(
  items: readonly Item[],
  labels: { include: string[]; exclude?: string[] },
  weekId = WEEK,
): Promise<void> {
  await writeJson(`weeks/${weekId}/items.json`, items);
  await writeJson(`weeks/${weekId}/labels.json`, {
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

function makeHarness(sources: Source[], maxItemsPerSource = USUAL_CAP): Harness {
  const collected: Item[][] = [];
  const close = vi.fn(() => Promise.resolve());
  const appDeps: DigestDeps = {
    config: makeConfig({ sources, maxItemsPerSource }),
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

const evalOptions = () => ({ profile: 'quality' as const, casesDir: root, minimums: NONE });

describe('the replay window', () => {
  it('serves a source with its own maxItems past the usual per-source cap', async () => {
    const items = feedItems('wide-feed', 30);
    await writeWeek(items, { include: ids('wide-feed', [1, 2, 3, 25, 30]) });
    const harness = makeHarness([source('wide-feed', 40)]);

    await runEval(evalOptions(), harness.deps);

    expect(idsOf(harness.firstReplay()).toSorted()).toEqual(idsOf(items).toSorted());
  });

  it("caps a source with no maxItems at the config's maxItemsPerSource, as production does", async () => {
    const items = feedItems('plain-feed', 30);
    await writeWeek(items, { include: ids('plain-feed', [1, 2, 3, 4, 5]) });
    const harness = makeHarness([source('plain-feed')]);

    await runEval(evalOptions(), harness.deps);

    expect(idsOf(harness.firstReplay()).toSorted()).toEqual(
      idsOf(items.slice(0, USUAL_CAP)).toSorted(),
    );
  });

  it('caps a recorded source that is not on the allowlist the same way', async () => {
    const items = [...feedItems('plain-feed', 5), ...feedItems('unlisted-feed', 30)];
    await writeWeek(items, { include: ids('plain-feed', [1, 2, 3, 4, 5]) });
    const harness = makeHarness([source('plain-feed')]);

    await runEval(evalOptions(), harness.deps);

    const seen = idsOf(harness.firstReplay());
    expect(seen.filter((id) => id.startsWith('unlisted-feed'))).toHaveLength(USUAL_CAP);
    expect(seen.filter((id) => id.startsWith('plain-feed'))).toHaveLength(5);
  });

  it('follows a changed maxItemsPerSource in the config', async () => {
    const items = feedItems('plain-feed', 30);
    await writeWeek(items, { include: ids('plain-feed', [1, 2, 3, 4, 5]) });
    const harness = makeHarness([source('plain-feed')], 12);

    await runEval(evalOptions(), harness.deps);

    expect(harness.firstReplay()).toHaveLength(12);
  });

  it("keeps a source's own maxItems when it is smaller than what was recorded", async () => {
    const items = feedItems('tight-feed', 15);
    await writeWeek(items, { include: ids('tight-feed', [1, 2, 3, 4, 5]) });
    const harness = makeHarness([source('tight-feed', 10)]);

    await runEval(evalOptions(), harness.deps);

    expect(idsOf(harness.firstReplay()).toSorted()).toEqual(
      ids('tight-feed', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).toSorted(),
    );
  });

  it('breaks a tie on publication time by file order, in the replay and in which labels are visible', async () => {
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

    const card = await runEval(evalOptions(), harness.deps);

    expect(idsOf(harness.firstReplay())).toEqual(ids('tied', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(card.metrics.mustExcludeLeaks.detail).toEqual({ notVisible: 1 });
    expect(card.metrics.mustIncludeRecall.detail).toBeUndefined();
  });

  it('checks the labels against the ids it served, whatever the caps of the sources', async () => {
    const items = [
      ...feedItems('a-feed', 25),
      ...feedItems('b-feed', 25),
      ...feedItems('c-feed', 8),
    ];
    await writeWeek(items, {
      include: [...ids('a-feed', [1, 2, 20]), ...ids('b-feed', [21, 25])],
      exclude: [...ids('a-feed', [21]), ...ids('c-feed', [8])],
    });
    const harness = makeHarness([source('a-feed'), source('b-feed', 24)]);

    const card = await runEval(evalOptions(), harness.deps);

    const served = new Set(idsOf(harness.firstReplay()));
    // a-feed-21 (cap 20) and b-feed-25 (cap 24) are not served; b-feed-21 and c-feed-8 are.
    expect(served.has('a-feed-21')).toBe(false);
    expect(served.has('b-feed-25')).toBe(false);
    expect(served.has('b-feed-21')).toBe(true);
    expect(served.has('c-feed-8')).toBe(true);
    expect(card.metrics.mustIncludeRecall.detail).toEqual({ notVisible: 1 });
    expect(card.metrics.mustExcludeLeaks.detail).toEqual({ notVisible: 1 });
  });
});

describe('the recorded weeks', () => {
  /** What production would collect for the week: each source's items up to its cap. */
  async function expectedServed(weekId: string): Promise<{ recorded: number; served: number }> {
    const text = await readFile(join(RECORDED_WEEKS_DIR, weekId, 'items.json'), 'utf8');
    const items = ItemSchema.array().parse(JSON.parse(text));
    const perSource = new Map<string, number>();
    for (const item of items) perSource.set(item.sourceId, (perSource.get(item.sourceId) ?? 0) + 1);
    const served = [...perSource].reduce((sum, [sourceId, count]) => {
      const cap = DEFAULT_SOURCES.find((s) => s.id === sourceId)?.maxItems ?? USUAL_CAP;
      return sum + Math.min(count, cap);
    }, 0);
    return { recorded: items.length, served };
  }

  it('are replayed under production caps with the default allowlist', async () => {
    await cp(RECORDED_WEEKS_DIR, join(root, 'weeks'), { recursive: true });
    const weekIds = (await readdir(RECORDED_WEEKS_DIR)).sort();
    const harness = makeHarness([...DEFAULT_SOURCES]);

    await runEval(evalOptions(), harness.deps);

    const expected = await Promise.all(weekIds.map(expectedServed));
    const replayed = harness.replays().slice(0, weekIds.length);
    expect(replayed.map((replay) => replay.length)).toEqual(expected.map((e) => e.served));
    // The cap bites somewhere: a week with a source past its cap serves fewer than it holds.
    expect(expected.some((e) => e.served < e.recorded)).toBe(true);
  });

  it('lose one labeled item to the window: 2026-W39 must-exclude d2871d486c61275a', async () => {
    // It is item 22 of openai-news, past the cap of 20. Every other label is served.
    await cp(RECORDED_WEEKS_DIR, join(root, 'weeks'), { recursive: true });
    const harness = makeHarness([...DEFAULT_SOURCES]);

    const card = await runEval(evalOptions(), harness.deps);

    expect(card.metrics.mustIncludeRecall.detail).toBeUndefined();
    expect(card.metrics.mustExcludeLeaks.detail).toEqual({ notVisible: 1 });
    expect(card.metrics.mustExcludeLeaks.note).toContain('1 labeled item(s)');
  });
});

describe('labels the replay cannot see', () => {
  it('load without complaint, however far down their source they sit', async () => {
    const items = feedItems('big-feed', RECORDED_ITEMS_PER_SOURCE + 1);
    await writeWeek(items, {
      include: ids('big-feed', [1, 2, 3, 4, 5]),
      exclude: ids('big-feed', [RECORDED_ITEMS_PER_SOURCE + 1]),
    });

    const { weeks } = await loadEvalCases(root);

    expect(weeks.map((week) => week.weekId)).toEqual([WEEK]);
  });

  it('are counted as not visible, not found and not failed', async () => {
    const items = feedItems('tight-feed', 15);
    await writeWeek(items, {
      include: ids('tight-feed', [1, 2, 3, 4, 12]),
      exclude: ids('tight-feed', [13]),
    });
    const harness = makeHarness([source('tight-feed', 10)]);

    const card = await runEval(evalOptions(), harness.deps);

    expect(harness.runDigest).toHaveBeenCalled();
    expect(card.metrics.mustIncludeRecall.detail).toEqual({ notVisible: 1 });
    expect(card.metrics.mustIncludeRecall.note).toBe(
      '1 labeled item(s) fall outside the replay window: they can be neither found nor leak',
    );
    expect(card.metrics.mustExcludeLeaks.detail).toEqual({ notVisible: 1 });
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('count as visible when they sit exactly at the cap of their source', async () => {
    const items = feedItems('tight-feed', 15);
    await writeWeek(items, { include: ids('tight-feed', [1, 2, 3, 4, 10]) });
    const harness = makeHarness([source('tight-feed', 10)]);

    const card = await runEval(evalOptions(), harness.deps);

    expect(card.metrics.mustIncludeRecall.detail).toBeUndefined();
  });

  it('add up over the weeks', async () => {
    await writeWeek(feedItems('tight-feed', 15), {
      include: ids('tight-feed', [1, 2, 3, 4, 11]),
    });
    const nextWeekStart = WEEK_START_MS + 7 * DAY_MS;
    await writeWeek(
      feedItems('next-feed', 15, nextWeekStart),
      { include: ids('next-feed', [1, 2, 3, 12, 13]) },
      '2026-W41',
    );
    const harness = makeHarness([source('tight-feed', 10), source('next-feed', 10)]);

    const card = await runEval(evalOptions(), harness.deps);

    expect(card.metrics.mustIncludeRecall.detail).toEqual({ notVisible: 3 });
  });
});
