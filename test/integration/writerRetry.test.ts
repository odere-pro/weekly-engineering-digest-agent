// W5-06 on the real fs store: a W39-like week (the only draft fails the link check, the writer's
// retry fixes it) ends sent, one that stays wrong ends blocked with the reasons on disk, and an
// aborted run ends failed with its lock released.
import { describe, expect, it } from 'vitest';
import { runDigest } from '../../src/digest/runDigest';
import { type DigestDeps } from '../../src/digest/types';
import { ExitCode } from '../../src/domain/schemas';
import { DATA_OPEN } from '../../src/shared/untrusted';
import { FIRST_WRITER, FRIDAY, PROFILE, TEST_TIMEOUT_MS, WEEK } from './harness/constants';
import { createWorld, type World } from './harness/world';
import { useDataDir } from './harness/dataDir';
import { readRunJson, readTextIfExists, runFile } from './harness/runFiles';
import { lockExists } from './harness/lock';

const dataDir = useDataDir();

const EVIL = 'https://evil.example/payload';

interface DigestJson {
  items: { summary: string }[];
}

/** The valid digest with an unknown URL in the first summary: the link check rejects it. */
function withUnknownLink(validReply: string): string {
  const digest = JSON.parse(validReply) as DigestJson;
  const [first, ...rest] = digest.items;
  const items = [{ ...first, summary: `Details at ${EVIL} today.` }, ...rest];
  return JSON.stringify({ ...digest, items });
}

/** One light-style writer, as on the week that exposed the gap (W39). */
function singleWriter(world: World): DigestDeps {
  return { ...world.deps, profile: { ...PROFILE, writers: [FIRST_WRITER], judge: null } };
}

const digestsSent = (world: World): number[] => world.deliveries.map((d) => d.digests.length);

interface DraftsFile {
  drafts: unknown[];
  failures: unknown[];
  rejections: { writer: string; attempt: number; rejectedBy: string[]; problems: string[] }[];
}

async function readDrafts(): Promise<DraftsFile> {
  const text = await readTextIfExists(runFile(dataDir(), WEEK, 'drafts.json'));
  return JSON.parse(text ?? '{}') as DraftsFile;
}

describe('integration: the writer retry', () => {
  it(
    'sends a week whose only draft fails the link check once, when the retry fixes it',
    async () => {
      let calls = 0;
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: (_request, valid) => (++calls === 1 ? withUnknownLink(valid()) : valid()),
      });

      const result = await runDigest(singleWriter(world));

      expect(calls).toBe(2);
      expect(result.exitCode).toBe(ExitCode.Sent);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toEqual(result.record);
      expect(record).toMatchObject({ status: 'sent', winner: FIRST_WRITER });
      expect(record.drafts).toEqual([{ writer: FIRST_WRITER, passed: true, rejectedBy: [] }]);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      const digest = await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'));
      expect(digest).toBe(result.markdown);
      expect(digest).not.toContain('evil.example');
      const drafts = await readDrafts();
      expect(drafts.rejections).toEqual([
        {
          writer: FIRST_WRITER,
          attempt: 1,
          rejectedBy: ['linkCheck'],
          problems: [`Unknown URL not in collected items: ${EVIL}`],
        },
      ]);
      expect(JSON.stringify(drafts.drafts)).not.toContain('evil.example');
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends the first attempt problems to the model inside a data block',
    async () => {
      let calls = 0;
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: (_request, valid) => (++calls === 1 ? withUnknownLink(valid()) : valid()),
      });

      await runDigest(singleWriter(world));

      const prompts = world.fake.generateCalls.map((call) => call.prompt);
      expect(prompts[0]).not.toContain('evil.example');
      const retry = prompts[1] ?? '';
      expect(retry).toContain(`${DATA_OPEN} check-problems>>>`);
      expect(retry.slice(retry.indexOf(`${DATA_OPEN} check-problems>>>`))).toContain(
        'Unknown URL not in collected items: [url removed]',
      );
      expect(retry).not.toContain('evil.example');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks a week whose retry is still wrong, with both attempts on disk and nothing sent',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: (_request, valid) => withUnknownLink(valid()),
      });

      const result = await runDigest(singleWriter(world), { noFallback: true });

      expect(world.fake.generateCalls).toHaveLength(2);
      expect(result.exitCode).toBe(ExitCode.Blocked);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toMatchObject({ status: 'blocked', winner: null });
      expect(record.drafts).toEqual([
        { writer: FIRST_WRITER, passed: false, rejectedBy: ['linkCheck'] },
      ]);
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      const drafts = await readDrafts();
      expect(drafts.rejections.map((rejection) => rejection.attempt)).toEqual([1, 2]);
      for (const delivery of world.deliveries) {
        expect(JSON.stringify(delivery.failures)).not.toContain('evil.example');
        expect(delivery.failures).toHaveLength(1);
      }
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'))).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: an aborted run', () => {
  it(
    'ends failed on disk, names the reason, and leaves no lock behind',
    async () => {
      const controller = new AbortController();
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        decide: (request, valid) => {
          controller.abort(new Error('scheduler timeout after 2h'));
          return valid();
        },
      });

      const result = await runDigest(world.deps, { signal: controller.signal });

      expect(result.exitCode).toBe(ExitCode.Failed);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toMatchObject({
        status: 'failed',
        error: {
          step: 'classify',
          message: 'Run aborted during the classify step: scheduler timeout after 2h',
        },
      });
      expect(await lockExists(dataDir())).toBe(false);
      expect(world.fake.generateCalls).toEqual([]);
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      const error = await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'));
      expect(JSON.parse(error ?? '{}')).toMatchObject({ step: 'classify' });
    },
    TEST_TIMEOUT_MS,
  );
});
