// W2-08: delivery is recorded per channel. A run that reached some channels fails with exit 1,
// and the next run of the week sends the saved digest.md to the other channels only, on the
// real run store, with no model at all.
import { describe, expect, it } from 'vitest';
import { QUESTION_IDS } from '../../src/core/prompts/classify.js';
import { ExitCode, type DeliveryId, type RunRecord } from '../../src/core/schemas.js';
import type { CapturingDelivery } from '../fakes/index.js';
import { connectionRefused } from './fakeOllama.js';
import {
  TEST_TIMEOUT_MS,
  FRIDAY,
  WEEK,
  createOllamaWorld,
  createWorld,
  lockExists,
  readRunJson,
  readTextIfExists,
  runCli,
  runFile,
  useDataDir,
  type World,
} from './harness.js';

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
        { weekId: WEEK, subject: SUBJECT, markdown: digest },
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
    'refuses to send a digest that a dry run replaced, until --force sends a new one everywhere',
    async () => {
      const partial = await failOnEmail();
      // This time the model reads v3.0.0 as the patch release, so the digest links other items.
      const preview = createWorld({
        now: RERUN,
        dataDir: dataDir(),
        decide: (request, valid) => {
          if (request.role !== 'classify') return valid();
          const minor = request.state.includes('runner v3.0.0') ? 0.9 : 0.1;
          return { ...valid(), [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: minor } };
        },
      });
      await runCli(preview, { dryRun: true });

      const rerun = createWorld({ now: RERUN, dataDir: dataDir() });
      const refused = await runCli(rerun);

      expect(refused.exitCode).toBe(ExitCode.Failed);
      expect(refused.stderr).toContain('run with --force to send a new digest to every channel');
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
});
