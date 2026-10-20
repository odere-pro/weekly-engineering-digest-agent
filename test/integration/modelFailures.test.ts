// Spec phase 4 exit gate, part 2: a slow or sloppy model. Timeouts and retries are the real
// Ollama adapter against a scripted fetch; repair is the real generateStructured in the write step.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runDigest } from '../../src/digest/runDigest';
import { ExitCode } from '../../src/domain/schemas';
import type { ModelProvider } from '../../src/models/ModelProvider';
import type { OllamaProviderOptions } from '../../src/models/adapters/ollama';
import { chatReply, hangUntilAborted } from './fakeOllama';
import { TEST_TIMEOUT_MS, FIRST_WRITER, FRIDAY, SECOND_WRITER, WEEK } from './harness/constants';
import { createWorld, type World } from './harness/world';
import { createOllamaWorld } from './harness/ollamaWorld';
import { useDataDir } from './harness/dataDir';
import { readRunJson, readTextIfExists, runFile } from './harness/runFiles';
import { lockExists } from './harness/lock';

// The real adapter waits 1 s, then 2 s, between attempts: about 5 s in real time over this file.
// These tests check that the retries happen, not how long they wait (`call/callOllama.test.ts`).
vi.mock('../../src/models/adapters/ollama', async (load) => {
  const actual = await load<{
    createOllamaProvider: (options: OllamaProviderOptions) => ModelProvider;
  }>();
  return {
    ...actual,
    createOllamaProvider: (options: OllamaProviderOptions) =>
      actual.createOllamaProvider({ retryBaseDelayMs: 1, ...options }),
  };
});

const dataDir = useDataDir();

const DraftsFileSchema = z.object({
  failures: z.array(z.object({ writer: z.string(), error: z.string() })),
});

const REPAIR_MARKER = 'Your previous answer did not match the required JSON schema.';
const INVALID_JSON = '{"headline": "cut off mid-sentence';
const EVERY_WRITER_FAILED = `Every writer failed: ${FIRST_WRITER}, ${SECOND_WRITER}; drafts.json has the reasons`;

const digestsSent = (world: World): number[] => world.deliveries.map((d) => d.digests.length);
const callsFor = (world: World, writer: string) =>
  world.fake.generateCalls.filter((call) => call.model === writer);

describe('integration: a model call that times out', () => {
  it(
    'retries a writer call that timed out and still sends the digest',
    async () => {
      const { world, ollama } = createOllamaWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        timeoutsMs: { write: 250 },
        chat: (call, validReply) =>
          call.model === FIRST_WRITER && call.nth === 1
            ? hangUntilAborted(call.signal)
            : chatReply(validReply(call.prompt)),
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      const chats = ollama.calls.filter((call) => call.path === '/api/chat');
      expect(chats.map((call) => [call.model, call.nth])).toEqual([
        [FIRST_WRITER, 1],
        [FIRST_WRITER, 2],
        [SECOND_WRITER, 1],
      ]);
      const retry = world.logs.find((line) => line.message === 'ollama call failed, retrying');
      expect(retry?.fields).toMatchObject({ role: 'write', model: FIRST_WRITER, attempt: 1 });
      expect(String(retry?.fields.error)).toContain('Timed out after 250 ms');
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('sent');
      expect(record.drafts.map((draft) => draft.passed)).toEqual([true, true]);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails the run with exit 1 and a failure note when a model keeps timing out',
    async () => {
      const { world, ollama } = createOllamaWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        decideOnFake: false,
        timeoutsMs: { classify: 30 },
        retries: 1,
        systemone: (call) => hangUntilAborted(call.signal),
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Failed);
      expect(ollama.calls.filter((call) => call.path === '/v1/systemone')).toHaveLength(2);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error?.step).toBe('classify');
      expect(record.error?.message).toContain('timed out after 30 ms');
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([
          { weekId: WEEK, step: 'classify', message: record.error?.message },
        ]);
      }
      // The steps before the failure left their files; the ones after did not run.
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'items.json'))).toBeDefined();
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'))).toBeDefined();
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'scores.json'))).toBeUndefined();
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: writers that keep timing out', () => {
  // D3 (decided 2026-10-17): a write step that yields no draft at all fails the run.
  it(
    'fails the run with exit 1 at write when every writer times out on every retry (D3)',
    async () => {
      const { world, ollama } = createOllamaWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        timeoutsMs: { write: 30 },
        retries: 1,
        chat: (call) => hangUntilAborted(call.signal),
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Failed);
      const chats = ollama.calls.filter((call) => call.path === '/api/chat');
      expect(chats.map((call) => [call.model, call.nth])).toEqual([
        [FIRST_WRITER, 1],
        [FIRST_WRITER, 2],
        [SECOND_WRITER, 1],
        [SECOND_WRITER, 2],
      ]);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error).toEqual({ step: 'write', message: EVERY_WRITER_FAILED });
      expect(record.drafts.map((draft) => draft.rejectedBy)).toEqual([['write'], ['write']]);
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([
          { weekId: WEEK, step: 'write', message: EVERY_WRITER_FAILED },
        ]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: a writer that returns invalid JSON', () => {
  it(
    'repairs the output once and still sends the digest',
    async () => {
      const original = new Map<string, string>();
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: (request, valid, validFor) => {
          const writer = request.model ?? '';
          if (request.prompt.includes(REPAIR_MARKER)) return validFor(original.get(writer) ?? '');
          original.set(writer, request.prompt);
          return writer === FIRST_WRITER ? INVALID_JSON : valid();
        },
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      const [first, repair] = callsFor(world, FIRST_WRITER);
      expect(callsFor(world, FIRST_WRITER)).toHaveLength(2);
      expect(first?.prompt).not.toContain(REPAIR_MARKER);
      expect(repair?.prompt).toContain(REPAIR_MARKER);
      expect(repair?.prompt).toContain(INVALID_JSON);
      expect(callsFor(world, SECOND_WRITER)).toHaveLength(1);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('sent');
      expect(record.drafts.map((draft) => draft.passed)).toEqual([true, true]);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends the other writer when one stays invalid after its repair',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: (request, valid) => (request.model === FIRST_WRITER ? INVALID_JSON : valid()),
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      expect(callsFor(world, FIRST_WRITER)).toHaveLength(2);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.winner).toBe(SECOND_WRITER);
      expect(record.drafts).toEqual([
        { writer: FIRST_WRITER, passed: false, rejectedBy: ['write'] },
        { writer: SECOND_WRITER, passed: true, rejectedBy: [] },
      ]);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  // D3 (decided 2026-10-17): invalid JSON after the one repair, for every writer, fails the
  // write step with exit 1. The failure note names the writers only; drafts.json has the reasons.
  it(
    'fails the run with exit 1 at write when every writer stays invalid after one repair (D3)',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: () => INVALID_JSON,
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Failed);
      // One call and exactly one repair per writer, never a second repair.
      expect(callsFor(world, FIRST_WRITER)).toHaveLength(2);
      expect(callsFor(world, SECOND_WRITER)).toHaveLength(2);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error).toEqual({ step: 'write', message: EVERY_WRITER_FAILED });
      expect(record.drafts).toEqual([
        { writer: FIRST_WRITER, passed: false, rejectedBy: ['write'] },
        { writer: SECOND_WRITER, passed: false, rejectedBy: ['write'] },
      ]);
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([
          { weekId: WEEK, step: 'write', message: EVERY_WRITER_FAILED },
        ]);
      }
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      const draftsFile = await readTextIfExists(runFile(dataDir(), WEEK, 'drafts.json'));
      expect(draftsFile).toBeDefined();
      const drafts = DraftsFileSchema.parse(JSON.parse(draftsFile ?? ''));
      expect(drafts.failures.map((failure) => failure.writer)).toEqual([
        FIRST_WRITER,
        SECOND_WRITER,
      ]);
      for (const failure of drafts.failures) {
        expect(failure.error).toContain('failed validation after one repair attempt');
      }
      const errorFile = await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'));
      expect(JSON.parse(errorFile ?? '{}')).toMatchObject({ step: 'write' });
      expect(await world.store.hasSentDigest(WEEK)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
