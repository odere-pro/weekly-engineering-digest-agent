// W2-08: delivery is recorded per channel. A run that reached some channels fails with exit 1,
// and the next run of the week sends the saved digest.md to the other channels only, on the
// real run store, with no model at all.
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { QUESTION_IDS } from '../../src/classify/classifyPrompt';
import { KEPT_SENT_REASON } from '../../src/digest/ending/keepReason';
import { ExitCode } from '../../src/domain/schemas';
import { type DeliveryId } from '../../src/delivery/deliveryId';
import { type RunRecord } from '../../src/store/runRecord';
import type { CapturingDelivery } from '../fakes';
import { connectionRefused } from './fakeOllama';
import { TEST_TIMEOUT_MS, FRIDAY, WEEK } from './harness/constants';
import { createWorld, type World } from './harness/world';
import { createOllamaWorld } from './harness/ollamaWorld';
import { useDataDir } from './harness/dataDir';
import { readRunJson, readTextIfExists, runFile } from './harness/runFiles';
import { lockExists } from './harness/lock';
import { runCli } from './harness/runCli';

const dataDir = useDataDir();

/** An hour after the failed run. */
const RERUN = '2026-10-16T06:45:00Z';
const SUBJECT = `Engineering digest ${WEEK}: This week: tool calling and faster runners`;

const digestsSent = (world: World): number[] => world.deliveries.map((d) => d.digests.length);
const modelCalls = (world: World): number =>
  world.fake.decideCalls.length + world.fake.generateCalls.length;

function channel(world: World, id: DeliveryId): CapturingDelivery {
  const found = world.deliveries.find((delivery) => delivery.id === id);
  if (!found) throw new Error(`The world has no ${id} channel`);
  return found;
}

/** Runs the week with email refusing the digest; returns the record it left on disk. */
async function failOnEmail(): Promise<RunRecord> {
  const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
  channel(world, 'email').failWith = new Error('SMTP 451 try again later');

  const cli = await runCli(world);

  expect(cli.exitCode).toBe(ExitCode.Failed);
  expect(digestsSent(world)).toEqual([1, 0, 1]);
  return readRunJson(dataDir(), WEEK);
}

describe('integration: a channel that refuses the digest', () => {
  it(
    'fails with exit 1 and records the channels that took the digest and its URLs',
    async () => {
      const record = await failOnEmail();

      expect(record).toMatchObject({
        status: 'failed',
        deliveredTo: ['markdown', 'slack'],
        error: {
          step: 'deliver',
          message:
            'Delivery failed on email (SMTP 451 try again later); delivered on markdown, slack',
        },
      });
      expect(record.sentUrls).toHaveLength(3);
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'))).toBeDefined();
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: rerunning a partly delivered week', () => {
  it(
    'sends the saved digest to the missing channel only, with Ollama down, and ends sent',
    async () => {
      const partial = await failOnEmail();
      const digest = await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'));
      // A new process: only the data dir carries over. Ollama being down proves no model is used.
      const { world, ollama } = createOllamaWorld({
        now: RERUN,
        dataDir: dataDir(),
        down: connectionRefused(),
      });

      const cli = await runCli(world);

      expect(cli.exitCode).toBe(ExitCode.Sent);
      expect(cli.stdout).toContain('Status    sent');
      expect(digestsSent(world)).toEqual([0, 1, 0]);
      expect(channel(world, 'email').digests).toEqual([
        {
          weekId: WEEK,
          subject: SUBJECT,
          markdown: digest,
          view: expect.objectContaining({ weekId: WEEK }) as unknown,
        },
      ]);
      expect(ollama.calls).toEqual([]);
      expect(modelCalls(world)).toBe(0);
      expect([...world.rss.calls, ...world.github.calls]).toEqual([]);
      for (const delivery of world.deliveries) expect(delivery.failures).toEqual([]);
      const record = await readRunJson(dataDir(), WEEK);
      const { error: _error, ...kept } = partial;
      expect(record).toEqual({
        ...kept,
        status: 'sent',
        startedAt: new Date(RERUN).toISOString(),
        finishedAt: new Date(RERUN).toISOString(),
        deliveredTo: ['markdown', 'slack', 'email'],
        timings: [...partial.timings, { step: 'deliver', ms: 0 }],
      });
      expect(await world.store.hasSentDigest(WEEK)).toBe(true);
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs the whole week again and delivers to every channel with --force',
    async () => {
      await failOnEmail();
      const world = createWorld({ now: RERUN, dataDir: dataDir() });

      const cli = await runCli(world, { force: true });

      expect(cli.exitCode).toBe(ExitCode.Sent);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      expect(modelCalls(world)).toBeGreaterThan(0);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toMatchObject({
        status: 'sent',
        startedAt: new Date(RERUN).toISOString(),
        deliveredTo: ['markdown', 'email', 'slack'],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the partly delivered record through a dry run, so the next run still resumes',
    async () => {
      const partial = await failOnEmail();
      const preview = createWorld({ now: RERUN, dataDir: dataDir() });

      const dry = await runCli(preview, { dryRun: true });

      expect(dry.exitCode).toBe(ExitCode.Sent);
      expect(digestsSent(preview)).toEqual([0, 0, 0]);
      expect(modelCalls(preview)).toBeGreaterThan(0);
      expect(await readRunJson(dataDir(), WEEK)).toEqual(partial);

      const rerun = createWorld({ now: RERUN, dataDir: dataDir() });
      const cli = await runCli(rerun);

      expect(cli.exitCode).toBe(ExitCode.Sent);
      expect(digestsSent(rerun)).toEqual([0, 1, 0]);
      expect(modelCalls(rerun)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps every file of the week through a dry run that would write another digest, and the next run sends it',
    async () => {
      await failOnEmail();
      const files = ['items.json', 'scores.json', 'drafts.json', 'digest.md'];
      const read = (): Promise<(string | undefined)[]> =>
        Promise.all(files.map((name) => readTextIfExists(runFile(dataDir(), WEEK, name))));
      const before = await read();
      // This time the model reads v3.0.0 as the patch release, so the dry run picks other items.
      const preview = createWorld({
        now: RERUN,
        dataDir: dataDir(),
        decide: (request, valid) => {
          if (request.role !== 'classify') return valid();
          const minor = request.state.includes('runner v3.0.0') ? 0.9 : 0.1;
          return { ...valid(), [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: minor } };
        },
      });

      const dry = await runCli(preview, { dryRun: true });

      expect(dry.exitCode).toBe(ExitCode.Sent);
      expect(modelCalls(preview)).toBeGreaterThan(0);
      expect(await read()).toEqual(before);
      // `digest run` names the digest file whenever the run wrote one.
      expect(dry.stdout).not.toMatch(/^Digest\s/m);

      const rerun = createWorld({ now: RERUN, dataDir: dataDir() });
      const cli = await runCli(rerun);

      expect(cli.exitCode).toBe(ExitCode.Sent);
      expect(channel(rerun, 'email').digests).toEqual([
        {
          weekId: WEEK,
          subject: SUBJECT,
          markdown: before[3],
          view: expect.objectContaining({ weekId: WEEK }) as unknown,
        },
      ]);
      expect(modelCalls(rerun)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a digest.md that no longer matches what was sent, until --force sends a new one everywhere',
    async () => {
      const partial = await failOnEmail();
      // Someone put another digest in the week's folder.
      const other = `# Another week\n\n[Source](https://example.com/other)\n`;
      await writeFile(runFile(dataDir(), WEEK, 'digest.md'), other, 'utf8');

      const rerun = createWorld({ now: RERUN, dataDir: dataDir() });
      const refused = await runCli(rerun);

      expect(refused.exitCode).toBe(ExitCode.Failed);
      expect(refused.stderr).toContain('run with --force to send a new digest to every channel');
      expect(refused.stdout).not.toMatch(/^Digest\s/m);
      expect(digestsSent(rerun)).toEqual([0, 0, 0]);
      expect(modelCalls(rerun)).toBe(0);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toMatchObject({ status: 'failed', deliveredTo: partial.deliveredTo });

      const forced = createWorld({ now: RERUN, dataDir: dataDir() });
      const cli = await runCli(forced, { force: true });

      expect(cli.exitCode).toBe(ExitCode.Sent);
      expect(digestsSent(forced)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves a sent week as it was when a forced run fails everywhere, and names no digest file',
    async () => {
      const first = createWorld({ now: FRIDAY, dataDir: dataDir() });
      await runCli(first);
      const digest = await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'));
      const sent = await readRunJson(dataDir(), WEEK);
      const forced = createWorld({ now: RERUN, dataDir: dataDir() });
      for (const delivery of forced.deliveries) delivery.failWith = new Error('offline');

      const cli = await runCli(forced, { force: true });

      expect(cli.exitCode).toBe(ExitCode.Failed);
      expect(cli.stdout).not.toMatch(/^Digest\s/m);
      expect(cli.stdout).toContain(`${KEPT_SENT_REASON}. The week's run folder is unchanged.`);
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'))).toBe(digest);
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'))).toBeUndefined();
      expect(await readRunJson(dataDir(), WEEK)).toEqual(sent);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells the person why a forced dry run on a sent week printed no digest, and changes no file',
    async () => {
      const first = createWorld({ now: FRIDAY, dataDir: dataDir() });
      await runCli(first);
      const files = ['items.json', 'scores.json', 'drafts.json', 'digest.md', 'run.json'];
      const read = (): Promise<(string | undefined)[]> =>
        Promise.all(files.map((name) => readTextIfExists(runFile(dataDir(), WEEK, name))));
      const before = await read();
      expect(before.every((text) => text !== undefined)).toBe(true);
      const preview = createWorld({ now: RERUN, dataDir: dataDir() });

      const cli = await runCli(preview, { force: true, dryRun: true });

      expect(cli.exitCode).toBe(ExitCode.Sent);
      expect(modelCalls(preview)).toBeGreaterThan(0);
      expect(digestsSent(preview)).toEqual([0, 0, 0]);
      expect(cli.stdout).toMatch(/Status\s+dry-run/);
      expect(cli.stdout).not.toMatch(/^Digest\s/m);
      const lines = cli.stdout.trimEnd().split('\n');
      expect(lines.at(-1)).toBe(`${KEPT_SENT_REASON}. The week's run folder is unchanged.`);
      expect(await read()).toEqual(before);
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'))).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
