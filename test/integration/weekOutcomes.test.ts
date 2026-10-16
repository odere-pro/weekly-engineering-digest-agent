// Spec phase 4 exit gate, part 1: what a week ends as. A bad feed, a quiet week, a blocked week
// and a dead Ollama each leave the right exit code, the right note and a full record on disk.
import { describe, expect, it } from 'vitest';
import { requiredModels } from '../../src/config/profiles.js';
import { QUESTION_IDS } from '../../src/core/prompts/classify.js';
import { runDigest } from '../../src/core/runDigest.js';
import { ExitCode } from '../../src/core/schemas.js';
import { FakeOutputGuard } from '../fakes/index.js';
import { connectionRefused } from './fakeOllama.js';
import {
  TEST_TIMEOUT_MS,
  FIRST_WRITER,
  FRIDAY,
  IRRELEVANT_ANSWER,
  OLLAMA_URL,
  PROFILE,
  SECOND_WRITER,
  WEEK,
  createOllamaWorld,
  createWorld,
  lockExists,
  readRunJson,
  readTextIfExists,
  runFile,
  useDataDir,
  type World,
} from './harness.js';

const dataDir = useDataDir();

const digestsSent = (world: World): number[] => world.deliveries.map((d) => d.digests.length);

describe('integration: a bad feed', () => {
  it(
    'lists a failed feed in run.json and still sends the digest',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        feeds: { 'broken-feed': new Error('HTTP 404') },
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toEqual(result.record);
      expect(record).toMatchObject({
        status: 'sent',
        failedSources: [{ sourceId: 'broken-feed', error: 'HTTP 404' }],
        counts: { collected: 4, selected: 3, digestItems: 3 },
        winner: FIRST_WRITER,
      });
      expect(record.sentUrls).toHaveLength(3);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      for (const delivery of world.deliveries) expect(delivery.failures).toEqual([]);
      const digest = await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'));
      expect(digest).toBeDefined();
      expect(digest).toBe(result.markdown);
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: a quiet week', () => {
  it(
    'ends as quiet with exit 3 when nothing is relevant, and sends nothing',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        decide: (request, valid) =>
          request.role === 'classify'
            ? { ...valid(), [QUESTION_IDS.relevance]: IRRELEVANT_ANSWER }
            : valid(),
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Quiet);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toMatchObject({
        status: 'quiet',
        counts: { collected: 4, selected: 0, digestItems: 0 },
        winner: null,
      });
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      for (const delivery of world.deliveries) expect(delivery.failures).toEqual([]);
      expect(world.fake.generateCalls).toEqual([]);
      expect(await world.store.hasSentDigest(WEEK)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends as quiet and names the failed feeds when every feed fails',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        feeds: {
          'model-blog': new Error('HTTP 503'),
          runner: new Error('HTTP 503'),
          'broken-feed': new Error('HTTP 404'),
        },
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Quiet);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('quiet');
      expect(record.failedSources.map((failed) => failed.sourceId).sort()).toEqual([
        'broken-feed',
        'model-blog',
        'runner',
      ]);
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([
          { weekId: WEEK, step: 'collect', message: 'no items collected (3 of 3 sources failed)' },
        ]);
      }
      expect(world.fake.decideCalls).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: every draft rejected', () => {
  it(
    'ends as blocked with exit 2 and a failure note naming each rejected writer',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        outputGuards: [
          new FakeOutputGuard('graniteGroundedness', () => true),
          new FakeOutputGuard('clefRubric'),
        ],
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Blocked);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('blocked');
      expect(record.drafts).toEqual([
        { writer: FIRST_WRITER, passed: false, rejectedBy: ['graniteGroundedness'] },
        { writer: SECOND_WRITER, passed: false, rejectedBy: ['graniteGroundedness'] },
      ]);
      expect(record.winner).toBeNull();
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      const message =
        `every draft was rejected: ${FIRST_WRITER} (graniteGroundedness); ` +
        `${SECOND_WRITER} (graniteGroundedness)`;
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([{ weekId: WEEK, step: 'guardOutput', message }]);
      }
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'digest.md'))).toBeUndefined();
      expect(await world.store.hasSentDigest(WEEK)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: Ollama down', () => {
  it('fails with exit 1 before any collection and delivers nothing but a failure note', async () => {
    const { world, ollama } = createOllamaWorld({
      now: FRIDAY,
      dataDir: dataDir(),
      down: connectionRefused(),
    });

    const result = await runDigest(world.deps);

    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.markdown).toBeUndefined();
    const record = await readRunJson(dataDir(), WEEK);
    expect(record.status).toBe('failed');
    expect(record.error?.message).toContain(`Ollama is not reachable at ${OLLAMA_URL}`);
    expect(record.error?.step).toBeUndefined();
    expect(world.rss.calls).toEqual([]);
    expect(world.github.calls).toEqual([]);
    expect(ollama.calls.map((call) => call.path).sort()).toEqual(['/api/tags', '/api/version']);
    expect(await readTextIfExists(runFile(dataDir(), WEEK, 'items.json'))).toBeUndefined();
    expect(digestsSent(world)).toEqual([0, 0, 0]);
    for (const delivery of world.deliveries) {
      expect(delivery.failures).toEqual([{ weekId: WEEK, message: record.error?.message }]);
    }
    const errorFile = await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'));
    expect(errorFile).toBeDefined();
    expect(JSON.parse(errorFile ?? '')).toMatchObject({
      runId: WEEK,
      message: record.error?.message,
    });
    expect(await lockExists(dataDir())).toBe(false);
  });

  it('fails with exit 1 before any collection when a profile model is not pulled', async () => {
    const [missing, ...installed] = requiredModels(PROFILE);
    const { world, ollama } = createOllamaWorld({
      now: FRIDAY,
      dataDir: dataDir(),
      models: installed,
    });

    const result = await runDigest(world.deps);

    expect(result.exitCode).toBe(ExitCode.Failed);
    const message = result.record.error?.message ?? '';
    expect(message).toContain(`Ollama is missing models for profile "quality": ${missing}`);
    expect(ollama.calls.map((call) => call.path).sort()).toEqual(['/api/tags', '/api/version']);
    expect(world.rss.calls).toEqual([]);
    expect(digestsSent(world)).toEqual([0, 0, 0]);
    for (const delivery of world.deliveries) {
      expect(delivery.failures).toEqual([{ weekId: WEEK, message }]);
    }
  });
});
