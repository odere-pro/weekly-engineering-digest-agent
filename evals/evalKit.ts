// Shared set-up for the W5-04 harness tests: a cases folder in a temp dir, a fake app and a
// fake `runDigest` that runs the real collect step over the replay's fetchers.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { EvalDeps } from './runEval';
import type { AppHandle } from '../src/app/container';
import { PROFILES } from '../src/config/profiles';
import { renderDigest } from '../src/render/markdown';
import type { DigestDeps, RunOptions, RunResult } from '../src/digest/runDigest';
import type { GuardCheckId } from '../src/guards/guardVerdict';
import type { Item } from '../src/domain/schemas';
import { collectStep } from '../src/sources/collect';
import { makeConfig, makeDigest, makeItem, makeRunRecord } from '../test/builders';
import {
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  MemoryRunStore,
  fixedClock,
  noopLogger,
  noopTracer,
} from '../test/fakes';

export const DAY_MS = 86_400_000;
/** The test sets are tiny; this lifts the spec's minimum set sizes. */
export const NONE = { weeks: 0, attacks: 0, grounding: 0, classifier: 0 };
export const WEEK_40 = '2026-W40';
export const WEEK_41 = '2026-W41';

/** A cases folder per test; call once at the top of a `describe`. */
export function useCasesDir(): () => string {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-kit-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return () => root;
}

export async function writeJson(root: string, relativePath: string, data: unknown): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

/** Six items of one source, published at `publishedAt`; item n is titled `<prefix>n`. */
export function weekItems(publishedAt: string, titlePrefix: string): Item[] {
  return Array.from({ length: 6 }, (_, i) =>
    makeItem({ sourceId: 'feed-a', publishedAt, title: `${titlePrefix}${i + 1}` }),
  );
}

/** Writes a week whose labels name items by position (1-based). */
export async function writeWeek(
  root: string,
  weekId: string,
  publishedAt: string,
  labels: { include: number[]; exclude: number[] } = { include: [1, 2, 3, 4, 5], exclude: [6] },
): Promise<Item[]> {
  const items = weekItems(publishedAt, `${weekId}-`);
  const ids = (positions: number[]): string[] => positions.map((p) => items[p - 1]!.id);
  await writeJson(root, `weeks/${weekId}/items.json`, items);
  await writeJson(root, `weeks/${weekId}/labels.json`, {
    mustInclude: ids(labels.include),
    mustExclude: ids(labels.exclude),
  });
  return items;
}

/** Weeks 40 and 41 with their items, ready for a run. */
export async function writeStandardWeeks(root: string): Promise<[Item[], Item[]]> {
  const w40 = await writeWeek(root, WEEK_40, '2026-09-30T09:00:00Z');
  const w41 = await writeWeek(root, WEEK_41, '2026-10-07T09:00:00Z');
  return [w40, w41];
}

export interface FakeRunOptions {
  /** How many of the kept items the fake digest links to, per week if given a function. Default 4. */
  take?: number | ((weekId: string) => number);
  /** Guards the record reports as switched off. */
  disabledGuards?: GuardCheckId[];
  /** Items added to the digest that nobody collected: a link problem. */
  strangers?: Item[];
  winner?: string | null;
  score?: number;
  /** Return markdown instead of the canned digest; undefined means no digest. */
  markdownFor?: (weekId: string, run: number) => string | undefined;
  fail?: Error;
}

export interface Call {
  deps: DigestDeps;
  options: RunOptions;
  collected: Item[];
}

/** Runs the real collect step against the injected fetchers, then a canned digest. */
export function fakeRunDigest(calls: Call[], opts: FakeRunOptions = {}): EvalDeps['runDigest'] {
  return async (deps, options): Promise<RunResult> => {
    if (opts.fail) throw opts.fail;
    const now = deps.clock.now();
    const sinceDays = options.sinceDays ?? deps.config.windowDays;
    const { items: collected } = await collectStep(
      {
        sources: deps.config.sources,
        since: new Date(now.getTime() - sinceDays * DAY_MS),
        until: now,
        maxItemsPerSource: deps.config.maxItemsPerSource,
      },
      { fetchers: deps.fetchers, logger: deps.logger, clock: deps.clock, retries: 0 },
    );
    const weekId = options.weekId ?? WEEK_40;
    calls.push({ deps, options, collected });
    const kept: Item[] = [];
    for (const item of collected) {
      const verdicts = await Promise.all(deps.inputGuards.map((g) => g.checkItem(item)));
      if (!verdicts.some((v) => v.flagged)) kept.push(item);
    }
    const take = typeof opts.take === 'function' ? opts.take(weekId) : (opts.take ?? 4);
    const picked = [...kept.slice(0, take), ...(opts.strangers ?? [])];
    const canned = renderDigest(makeDigest(picked, { weekId }), { disabledGuards: [] });
    const markdown = opts.markdownFor ? opts.markdownFor(weekId, calls.length) : canned;
    const writer = opts.winner === undefined ? 'gemma' : opts.winner;
    return {
      record: makeRunRecord({
        runId: weekId,
        status: 'dry-run',
        dryRun: true,
        disabledGuards: opts.disabledGuards ?? [],
        winner: markdown === undefined ? null : writer,
        drafts:
          writer === null || markdown === undefined
            ? []
            : [
                {
                  writer,
                  passed: true,
                  rejectedBy: [],
                  ...(opts.score === undefined
                    ? {}
                    : { score: { writer, score: opts.score, byCriterion: {} } }),
                },
              ],
      }),
      exitCode: 0,
      ...(markdown === undefined ? {} : { markdown }),
    };
  };
}

export interface AppFixture {
  handle: AppHandle;
  close: ReturnType<typeof vi.fn>;
  deps: DigestDeps;
}

/** A fake app. The input guard flags any item whose title starts with IGNORE. */
export function makeApp(
  overrides: Partial<DigestDeps> = {},
  profile: DigestDeps['profile'] = PROFILES.quality,
): AppFixture {
  const deps: DigestDeps = {
    config: makeConfig({ guards: { input: { mode: 'all' }, output: { enabled: false } } }),
    profile,
    model: new FakeModelProvider(),
    fetchers: {},
    inputGuards: [
      new FakeInputGuard('clefPolicy', (item) => item.title.startsWith('IGNORE')),
      new FakeInputGuard('graniteRisk'),
    ],
    outputGuards: [new FakeOutputGuard('graniteGroundedness'), new FakeOutputGuard('clefRubric')],
    deliveries: [],
    store: new MemoryRunStore(),
    logger: noopLogger,
    tracer: noopTracer,
    clock: fixedClock('2030-01-01T00:00:00Z'),
    ...overrides,
  };
  const close = vi.fn(() => Promise.resolve());
  return { handle: { deps, close }, close, deps };
}

/** A clock that moves `stepMs` on every reading. */
export function tickingClock(stepMs: number): EvalDeps['clock'] {
  let t = Date.parse('2026-10-16T09:00:00Z');
  return {
    now: () => {
      const current = new Date(t);
      t += stepMs;
      return current;
    },
  };
}

export function makeDeps(
  app: AppFixture,
  calls: Call[],
  opts: FakeRunOptions = {},
  extra: Partial<EvalDeps> = {},
): EvalDeps {
  return {
    buildApp: vi.fn(() => Promise.resolve(app.handle)),
    runDigest: fakeRunDigest(calls, opts),
    clock: tickingClock(1000),
    ...extra,
  };
}
