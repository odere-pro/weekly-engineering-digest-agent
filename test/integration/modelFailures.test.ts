// Spec phase 4 exit gate, part 2: a slow or sloppy model. Timeouts and retries are the real
// Ollama adapter against a scripted fetch; repair is the real generateStructured in the write step.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runDigest } from '../../src/core/runDigest.js';
import { ExitCode } from '../../src/core/schemas.js';
import { chatReply, hangUntilAborted } from './fakeOllama.js';
import {
  TEST_TIMEOUT_MS,
  FIRST_WRITER,
  FRIDAY,
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

const DraftsFileSchema = z.object({
  failures: z.array(z.object({ writer: z.string(), error: z.string() })),
});

const REPAIR_MARKER = 'Your previous answer did not match the required JSON schema.';
const INVALID_JSON = '{"headline": "cut off mid-sentence';

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
  // Same drift as D3 below: a writer is a per-writer failure, so a panel that times out on
  // every retry blocks the week (exit 2) instead of failing the write step (exit 1).
  it(
    'blocks the week with exit 2 when every writer times out on every retry (D3)',
    async () => {
      const { world, ollama } = createOllamaWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        timeoutsMs: { write: 30 },
        retries: 1,
        chat: (call) => hangUntilAborted(call.signal),
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Blocked);
      const chats = ollama.calls.filter((call) => call.path === '/api/chat');
      expect(chats.map((call) => [call.model, call.nth])).toEqual([
        [FIRST_WRITER, 1],
        [FIRST_WRITER, 2],
        [SECOND_WRITER, 1],
        [SECOND_WRITER, 2],
      ]);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('blocked');
      expect(record.drafts.map((draft) => draft.rejectedBy)).toEqual([['write'], ['write']]);
      expect(digestsSent(world)).toEqual([0, 0, 0]);
      const message = `every draft was rejected: ${FIRST_WRITER} (write); ${SECOND_WRITER} (write)`;
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([{ weekId: WEEK, step: 'guardOutput', message }]);
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

  // Spec drift D3 (docs/system-design.md section 9): the spec says invalid JSON after the one
  // repair fails the step with exit 1. Today every writer failing ends the run `blocked` (exit 2)
  // with a failure note that names each writer. This pins what the code does; change it together
  // with the D3 decision.
  it(
    'blocks the week with exit 2 when every writer stays invalid after one repair (D3)',
    async () => {
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        generate: () => INVALID_JSON,
      });

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Blocked);
      // One call and exactly one repair per writer, never a second repair.
      expect(callsFor(world, FIRST_WRITER)).toHaveLength(2);
      expect(callsFor(world, SECOND_WRITER)).toHaveLength(2);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('blocked');
      expect(record.error).toBeUndefined();
      expect(record.drafts).toEqual([
        { writer: FIRST_WRITER, passed: false, rejectedBy: ['write'] },
        { writer: SECOND_WRITER, passed: false, rejectedBy: ['write'] },
      ]);
      const message = `every draft was rejected: ${FIRST_WRITER} (write); ${SECOND_WRITER} (write)`;
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([{ weekId: WEEK, step: 'guardOutput', message }]);
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
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'error.json'))).toBeUndefined();
      expect(await world.store.hasSentDigest(WEEK)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
