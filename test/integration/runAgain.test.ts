// "Run again": a week that was sent gets a variant digest beside it. The real run store and the
// real Markdown file channel write to a temp data dir; models, feeds, email and Slack are fakes.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppHandle } from '../../src/app/container';
import { runCommand, type RunCommandOptions } from '../../src/cli/run/run';
import { createMarkdownFileDelivery } from '../../src/delivery/adapters/markdownFile';
import { runDigest } from '../../src/digest/runDigest';
import type { DigestDeps } from '../../src/digest/types';
import { fixedClock } from '../fakes';
import { FRIDAY, OLLAMA_URL, PROFILE, TEST_TIMEOUT_MS, WEEK } from './harness/constants';
import { useDataDir } from './harness/dataDir';
import { readRunJson, runFile } from './harness/runFiles';
import { createWorld, type World } from './harness/world';

const dataDir = useDataDir();
const LATER = '2026-10-17T08:00:00Z';
const PERSPECTIVE_TEXT = 'this week is specifically interested in: \\"security\\"';

/** The harness world with the real Markdown file channel in place of the capturing one. */
function weekWithFiles(): { world: World; deps: DigestDeps } {
  const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
  const [, ...others] = world.deliveries;
  const file = createMarkdownFileDelivery({ dataDir: dataDir() });
  return { world, deps: { ...world.deps, deliveries: [file, ...others] } };
}

/** `digest run` over the deps, not interactive (so a variant flag sends without asking). */
async function runAgain(deps: DigestDeps, options: RunCommandOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const app: AppHandle = { deps, close: () => Promise.resolve() };
  const exitCode = await runCommand(options, {
    loadConfig: () =>
      Promise.resolve({
        config: deps.config,
        env: { OLLAMA_URL, LOG_LEVEL: 'info' },
        secrets: {},
        profile: PROFILE,
        platform: { os: 'darwin', arch: 'arm64' },
        configPath: join(dataDir(), 'digest.config.json'),
      }),
    buildApp: () => Promise.resolve(app),
    interactive: false,
    clock: fixedClock(LATER),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function sendFirstWeek(deps: DigestDeps) {
  const first = await runDigest(deps);
  expect(first.record.status).toBe('sent');
  const weekFile = runFile(dataDir(), WEEK, `${WEEK}.md`);
  return { weekFile, weekText: await readFile(weekFile, 'utf8'), record: first.record };
}

const sentCount = (world: World): number[] => world.deliveries.map((d) => d.digests.length);

describe('integration: run a sent week again', () => {
  it(
    'sends a perspective digest as its own file and marks the record with the variant',
    async () => {
      const { world, deps } = weekWithFiles();
      const first = await sendFirstWeek(deps);
      const callsBefore = world.fake.decideCalls.length;
      const writesBefore = world.fake.generateCalls.length;

      const result = await runAgain(deps, { perspective: 'security' });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const variantMd = runFile(dataDir(), WEEK, `${WEEK}-perspective-security.md`);
      expect((await readFile(variantMd, 'utf8')).length).toBeGreaterThan(0);
      expect(await readFile(first.weekFile, 'utf8')).toBe(first.weekText);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.variant).toEqual({ kind: 'perspective', topic: 'security' });
      expect(record.status).toBe('sent');
      expect(sentCount(world).slice(1)).toEqual([2, 2]);

      const classify = world.fake.decideCalls
        .slice(callsBefore)
        .filter((request) => request.role === 'classify');
      expect(classify.length).toBeGreaterThan(0);
      expect(JSON.stringify(classify)).toContain(PERSPECTIVE_TEXT);
      const writes = world.fake.generateCalls.slice(writesBefore);
      expect(writes.length).toBeGreaterThan(0);
      for (const call of writes) expect(JSON.stringify(call)).toContain('security');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with --dry-run writes only the variant files and sends nothing',
    async () => {
      const { world, deps } = weekWithFiles();
      const first = await sendFirstWeek(deps);

      const result = await runAgain(deps, { perspective: 'security', dryRun: true });

      expect(result.exitCode).toBe(0);
      const files = await readdir(join(dataDir(), '2026-10-12', 'digest'));
      expect(files).toContain(`${WEEK}-perspective-security.md`);
      expect(await readFile(first.weekFile, 'utf8')).toBe(first.weekText);
      expect(sentCount(world).slice(1)).toEqual([1, 1]);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.variant).toBeUndefined();
      expect(record).toEqual(first.record);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'builds a complete digest with every item that passed the filters in the message only',
    async () => {
      const { world, deps } = weekWithFiles();
      const first = await sendFirstWeek(deps);

      const result = await runAgain(deps, { complete: true });

      expect(result.exitCode).toBe(0);
      const variantMd = await readFile(runFile(dataDir(), WEEK, `${WEEK}-complete.md`), 'utf8');
      expect(variantMd).toContain('## Everything this week');
      expect(await readFile(first.weekFile, 'utf8')).not.toContain('## Everything this week');
      expect(await readFile(runFile(dataDir(), WEEK, 'digest.md'), 'utf8')).not.toContain(
        '## Everything this week',
      );
      expect((await readRunJson(dataDir(), WEEK)).variant).toEqual({ kind: 'complete' });
      expect(world.deliveries[2]?.digests[1]?.markdown).toContain('## Everything this week');
    },
    TEST_TIMEOUT_MS,
  );
});
