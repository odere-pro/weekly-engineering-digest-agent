// Spec phase-2 exit gate: one real dry run on the light profile, with the real feeds and the real
// Ollama models. Lane gpu: run alone with `LIVE_OLLAMA=1 pnpm vitest run test/live/smoke.live.test.ts`.
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppHandle } from '../../src/app/container';
import { loadConfig, type LoadedConfig } from '../../src/config/load';
import { modelsByRole } from '../../src/config/profiles';
import { runDigest } from '../../src/digest/runDigest';
import { type DigestDeps, type RunResult } from '../../src/digest/types';
import { ExitCode, type Item, type Urgency } from '../../src/domain/schemas';
import { RunRecordSchema } from '../../src/store/runRecord';
import type { SourceFetcher } from '../../src/sources/SourceFetcher';
import type { DigestViewItem } from '../../src/delivery/Delivery';
import { sameUrl } from '../../src/shared/url';
import { weekDigestDir } from '../../src/store/layout';

const EXAMPLE_CONFIG = fileURLToPath(new URL('../../digest.config.example.json', import.meta.url));
const SMOKE_PROFILE = 'light';
const RUN_TIMEOUT_MS = 1_800_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const DIGEST_MIN_ITEMS = 3;
const EM_DASH = '—';
const URGENCIES_WITH_ACTION: readonly Urgency[] = ['act-now', 'worth-a-look'];
const PIPELINE_STEPS = ['collect', 'guardInput', 'classify', 'process', 'write', 'guardOutput'];

interface SmokeRun {
  loaded: LoadedConfig;
  result: RunResult;
  collected: readonly Item[];
  runDir: string;
}

/** Wraps each fetcher so the test can see what the run collected. Returns a new map. */
function recordingFetchers(
  fetchers: DigestDeps['fetchers'],
  collected: Item[],
): DigestDeps['fetchers'] {
  const wrap = (fetcher: SourceFetcher | undefined): SourceFetcher | undefined =>
    fetcher && {
      kind: fetcher.kind,
      fetch: async (source, window, signal) => {
        const items = await fetcher.fetch(source, window, signal);
        collected.push(...items);
        return items;
      },
    };
  return { rss: wrap(fetchers.rss), github: wrap(fetchers.github) };
}

/** The example config on the light profile, with every output in `workDir`. */
async function writeSmokeConfig(workDir: string): Promise<string> {
  const example = JSON.parse(await readFile(EXAMPLE_CONFIG, 'utf8')) as Record<string, unknown>;
  const config = {
    ...example,
    profile: SMOKE_PROFILE,
    dataDir: join(workDir, 'data'),
    delivery: { markdown: { dir: join(workDir, 'digests') } },
  };
  const configPath = join(workDir, 'smoke.config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/** No .env is read: the env file does not exist and the process env is not passed on. */
async function startSmokeRun(workDir: string): Promise<{ app: AppHandle; run: SmokeRun }> {
  const loaded = await loadConfig({
    configPath: await writeSmokeConfig(workDir),
    envPath: join(workDir, 'absent.env'),
    processEnv: { LOG_LEVEL: 'warn', ...ollamaUrl() },
  });
  const app = await buildApp(loaded);
  const collected: Item[] = [];
  const deps: DigestDeps = {
    ...app.deps,
    fetchers: recordingFetchers(app.deps.fetchers, collected),
  };
  const result = await runDigest(deps, { dryRun: true });
  const runDir = weekDigestDir(loaded.config.dataDir, result.record.runId);
  return { app, run: { loaded, result, collected, runDir } };
}

function ollamaUrl(): { OLLAMA_URL?: string } {
  const url = process.env.OLLAMA_URL;
  return url ? { OLLAMA_URL: url } : {};
}

describe.skipIf(process.env.LIVE_OLLAMA !== '1')('digest smoke run on light (live)', () => {
  let workDir = '';
  let run: SmokeRun;
  let app: AppHandle | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'digest-smoke-'));
    ({ app, run } = await startSmokeRun(workDir));
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, CLEANUP_TIMEOUT_MS);

  it('finishes a dry run that produced a digest', () => {
    const { record, markdown, exitCode } = run.result;

    expect(record.error).toBeUndefined();
    expect(record.status).toBe('dry-run');
    expect(record.dryRun).toBe(true);
    expect(exitCode).toBe(ExitCode.Sent);
    expect(markdown).toBeTypeOf('string');
  });

  it('uses the light profile models for every role', () => {
    const { record } = run.result;

    expect(record.profile).toBe(SMOKE_PROFILE);
    expect(record.modelsByRole).toEqual(modelsByRole(run.loaded.profile));
  });

  it('collects from live feeds and narrows to a digest of 3 to topN items', () => {
    const { record } = run.result;
    const { counts } = record;

    expect(counts.collected).toBeGreaterThan(0);
    expect(record.failedSources.length).toBeLessThan(run.loaded.config.sources.length);
    expect(counts.afterGuardInput).toBeLessThanOrEqual(counts.collected);
    expect(counts.classified).toBeLessThanOrEqual(counts.afterGuardInput);
    expect(counts.selected).toBeLessThanOrEqual(counts.classified);
    expect(counts.digestItems).toBeGreaterThanOrEqual(DIGEST_MIN_ITEMS);
    expect(counts.digestItems).toBeLessThanOrEqual(run.loaded.config.topN);
  });

  it('times every pipeline step', () => {
    const steps = run.result.record.timings.map((timing) => timing.step);

    expect(steps).toEqual(expect.arrayContaining(PIPELINE_STEPS));
  });

  it('names the light writer as the winner and shows it passed every check', () => {
    const { record } = run.result;
    const writer = run.loaded.profile.writers[0];
    const draft = record.drafts.find((candidate) => candidate.writer === writer);

    expect(record.winner).toBe(writer);
    expect(draft).toMatchObject({ passed: true, rejectedBy: [] });
  });

  it('gives every digest item an urgency and an action where the reader must act', () => {
    const view = run.result.message?.view;
    const groups = view?.groups ?? [];
    const itemCount = groups.reduce((sum, group) => sum + group.items.length, 0);

    expect(itemCount).toBe(run.result.record.counts.digestItems);
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
      if (!URGENCIES_WITH_ACTION.includes(group.urgency)) continue;
      for (const item of group.items) {
        expect(item.action?.trim(), `action of "${item.title}"`).toBeTruthy();
      }
    }
    expect(view?.title).toMatch(
      /^Week \S+: \d+ releases?, (\d+ needs? action|nothing needs action)$/,
    );
  });

  it('writes a digest that obeys the format rules and links only collected items', () => {
    const markdown = run.result.markdown ?? '';
    const items: DigestViewItem[] = (run.result.message?.view?.groups ?? []).flatMap((group) => [
      ...group.items,
    ]);
    const links = items.map((item) => item.url);

    expect(markdown).not.toContain(EM_DASH);
    expect(links).toHaveLength(run.result.record.counts.digestItems);
    for (const link of links) {
      expect(run.collected.some((item) => sameUrl(item.url, link))).toBe(true);
    }
    expect(new Set(links).size).toBe(links.length);
    // A dry run delivers nothing, so since W2-08 it records no sent URLs (next week's dedupe).
    expect(run.result.record.sentUrls).toEqual([]);
  });

  it('leaves a valid run record and the digest on disk, and delivers nothing', async () => {
    const onDisk: unknown = JSON.parse(await readFile(join(run.runDir, 'run.json'), 'utf8'));
    const digestFile = await readFile(join(run.runDir, 'digest.md'), 'utf8');

    expect(RunRecordSchema.parse(onDisk)).toEqual(run.result.record);
    expect(digestFile).toBe(run.result.markdown);
    await expect(access(join(workDir, 'digests'))).rejects.toThrow();
  });
});
