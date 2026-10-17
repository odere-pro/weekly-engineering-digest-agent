// Why a draft was rejected (W5-06, F6) and the one writer retry when no draft passes the link or
// format check (F1).
import { describe, expect, it } from 'vitest';
import { runDigest, type DigestDeps, type RunOptions } from '../../src/core/runDigest.js';
import {
  ExitCode,
  RunRecordSchema,
  type Digest,
  type Draft,
  type Item,
  type RunRecord,
} from '../../src/core/schemas.js';
import { QUESTION_IDS } from '../../src/core/prompts/classify.js';
import { JUDGE_CRITERIA } from '../../src/core/prompts/judge.js';
import { MAX_PROBLEMS, PROBLEM_MAX_CHARS } from '../../src/core/prompts/write.js';
import { requiredModels, type ModelProfile } from '../../src/config/profiles.js';
import type { DecisionAnswer } from '../../src/ports/ModelProvider.js';
import type { ArtifactName } from '../../src/ports/RunStore.js';
import type { LogFields, Logger } from '../../src/shared/telemetry.js';
import { DATA_OPEN, UNTRUSTED_DATA_RULE } from '../../src/shared/untrusted.js';
import { makeConfig, makeItem } from '../builders.js';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  MemoryRunStore,
  fixedClock,
  noopTracer,
} from '../fakes/index.js';

const WEEK = '2026-W42';
const NOW = '2026-10-16T08:00:00Z';
const PUBLISHED = '2026-10-14T09:00:00Z';
const AREA = 'AI models and tooling';
const WRITER_A = 'writer-a:31b';
const WRITER_B = 'writer-b:30b';
const WRITER_C = 'writer-c:9b';
const EVIL = 'https://evil.example/payload';
const EVIL_PROBLEM = `Unknown URL not in collected items: ${EVIL}`;
const EM_DASH = '—';

const PROFILE: ModelProfile = {
  name: 'quality',
  classify: 'classifier:2b',
  guardPolicy: 'policy:2b',
  guardRisk: 'risk:8b',
  writers: [WRITER_A, WRITER_B],
  judge: 'judge:9b',
  requiresAppleSilicon: false,
  minOllamaVersion: '0.0.0',
};
const SINGLE_WRITER: ModelProfile = { ...PROFILE, writers: [WRITER_A], judge: null };

type DigestBody = Omit<Digest, 'weekId'>;

interface WriterCall {
  writer: string;
  /** 1 for the writer's first call, 2 for its retry. */
  attempt: number;
  items: readonly Item[];
  prompt: string;
}

interface Scenario {
  profile?: ModelProfile;
  /** The writer's reply; throw to fail the call. A string is sent as is. */
  reply?: (call: WriterCall) => DigestBody | string;
  flagOutput?: (draft: Draft) => boolean;
}

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

function recordingLogger(lines: LogLine[], bound: LogFields = {}): Logger {
  const at =
    (level: LogLine['level']) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields: { ...bound, ...fields } });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (fields) => recordingLogger(lines, { ...bound, ...fields }),
  };
}

const scoreAnswer = (level: number, top: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / top,
  probabilities: {},
  confidence: 0.9,
});

function bodyFor(items: readonly Item[]): DigestBody {
  return {
    headline: 'Runners and gateways moved this week',
    intro: 'These releases change how teams build and ship.',
    items: items.map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      area: AREA,
      summary: `${item.title} with faster builds.`,
      whyItMatters: 'Teams can cut CI time without new hardware.',
    })),
  };
}

/** The body with an unknown URL in the first item's summary: the link check rejects it. */
function withBadLink(body: DigestBody, url = EVIL): DigestBody {
  const [first, ...rest] = body.items;
  return { ...body, items: [{ ...first!, summary: `Details at ${url} today.` }, ...rest] };
}

/** The body with a first item far over the word limit: the format check rejects it. */
function withTooManyWords(body: DigestBody): DigestBody {
  const [first, ...rest] = body.items;
  return { ...body, items: [{ ...first!, whyItMatters: 'word '.repeat(600).trim() }, ...rest] };
}

function setup(scenario: Scenario = {}) {
  const profile = scenario.profile ?? PROFILE;
  const items = Array.from({ length: 4 }, (_, index) =>
    makeItem({ title: `Runner ${index + 1}.0 ships`, publishedAt: PUBLISHED }),
  );
  const logs: LogLine[] = [];
  const calls: WriterCall[] = [];
  const attempts = new Map<string, number>();
  const model = new FakeModelProvider({
    health: {
      reachable: true,
      models: requiredModels(profile).map((name) => ({ name, capabilities: [] })),
    },
    decide: (request) => {
      if (request.role === 'judge') {
        return Object.fromEntries(JUDGE_CRITERIA.map((name) => [name, scoreAnswer(3, 4)]));
      }
      return {
        [QUESTION_IDS.relevance]: scoreAnswer(2.5, 3),
        [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
        [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
        [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
      };
    },
    generate: (request) => {
      const writer = request.model ?? '';
      const attempt = (attempts.get(writer) ?? 0) + 1;
      attempts.set(writer, attempt);
      const given = items.filter((item) => request.prompt.includes(`${DATA_OPEN} ${item.id}>>>`));
      const call = { writer, attempt, items: given, prompt: request.prompt };
      calls.push(call);
      const reply = scenario.reply ? scenario.reply(call) : bodyFor(given);
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  });
  const outputGuards = [
    new FakeOutputGuard('graniteGroundedness', scenario.flagOutput),
    new FakeOutputGuard('clefRubric'),
  ];
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const deps: DigestDeps = {
    config: makeConfig({ focusAreas: [AREA, 'Platform engineering'] }),
    profile,
    model,
    fetchers: { rss: new FakeSourceFetcher('rss', { 'example-feed': items }) },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards,
    deliveries,
    store,
    logger: recordingLogger(logs),
    tracer: noopTracer,
    clock: fixedClock(NOW),
  };
  const run = (options: RunOptions = {}) => runDigest(deps, options);
  const artifact = (name: ArtifactName): string | undefined =>
    store.artifacts.get(`${WEEK}/${name}`);
  const draftsFile = () =>
    JSON.parse(artifact('drafts.json') ?? '{}') as {
      drafts: Draft[];
      failures: { writer: string; error: string; retry?: boolean }[];
      rejections: { writer: string; attempt: number; rejectedBy: string[]; problems: string[] }[];
    };
  const callsOf = (writer: string) => calls.filter((call) => call.writer === writer);
  const warnings = (message: string) =>
    logs.filter((line) => line.level === 'warn' && line.message === message);
  return {
    run,
    items,
    model,
    store,
    deliveries,
    outputGuards,
    logs,
    calls,
    callsOf,
    artifact,
    draftsFile,
    warnings,
  };
}

function expectValidRecord(record: RunRecord): void {
  expect(RunRecordSchema.parse(record)).toEqual(record);
}

describe('runDigest: why a draft was rejected (F6)', () => {
  it('logs the link check problems of a rejected draft at warn, in the write step', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ items }) => withBadLink(bodyFor(items)),
    });

    await h.run({ dryRun: true });

    expect(h.warnings('Draft failed the checks')[0]).toEqual({
      level: 'warn',
      message: 'Draft failed the checks',
      fields: {
        runId: WEEK,
        step: 'write',
        writer: WRITER_A,
        attempt: 1,
        rejectedBy: ['linkCheck'],
        problems: [EVIL_PROBLEM],
      },
    });
  });

  it('logs the format check problems too, including the word count', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ items }) => withTooManyWords(bodyFor(items)),
    });

    await h.run({ dryRun: true });

    const [line] = h.warnings('Draft failed the checks');
    expect(line?.fields).toMatchObject({ rejectedBy: ['formatCheck'] });
    expect(line?.fields.problems).toEqual([
      expect.stringMatching(/^Expected under 500 words, got \d+/),
    ]);
  });

  it('stores the problems of every rejected attempt in drafts.json, next to the final drafts', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ items }) => withBadLink(bodyFor(items)),
    });

    await h.run({ dryRun: true });

    const file = h.draftsFile();
    expect(file.rejections).toEqual([
      { writer: WRITER_A, attempt: 1, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
      { writer: WRITER_A, attempt: 2, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
    ]);
    expect(file.drafts.map((draft) => draft.writer)).toEqual([WRITER_A]);
    expect(file.failures).toEqual([]);
  });

  it('stores an empty list, not a missing key, when every draft passed', async () => {
    const h = setup();

    await h.run({ dryRun: true });

    expect(h.draftsFile().rejections).toEqual([]);
    expect(h.warnings('Draft failed the checks')).toEqual([]);
  });

  it('bounds the problems: the first few, each cut short, and a count of the rest', async () => {
    const urls = Array.from({ length: MAX_PROBLEMS + 7 }, (_, i) => `https://evil.example/${i}`);
    const long = `https://evil.example/${'x'.repeat(900)}`;
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ items }) => withBadLink(bodyFor(items), [long, ...urls].join(' and ')),
    });

    await h.run({ dryRun: true });

    const [line] = h.warnings('Draft failed the checks');
    const logged = line?.fields.problems as string[];
    expect(logged).toHaveLength(MAX_PROBLEMS + 1);
    expect(logged.slice(0, MAX_PROBLEMS).every((p) => p.length <= PROBLEM_MAX_CHARS)).toBe(true);
    expect(logged.at(-1)).toBe('and 8 more problems');
    expect(h.draftsFile().rejections[0]?.problems).toEqual(logged);
  });

  it('keeps model text out of the record, the failure note and the run.json', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ items }) => withBadLink(bodyFor(items)),
    });

    const result = await h.run();

    expect(result.record.status).toBe('blocked');
    expect(JSON.stringify(result.record)).not.toContain('evil.example');
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        {
          weekId: WEEK,
          step: 'guardOutput',
          message: `every draft was rejected: ${WRITER_A} (linkCheck)`,
        },
      ]);
    }
  });
});

describe('runDigest: one retry when no draft passes the checks (F1)', () => {
  it('sends a week whose only draft fails the link check once, when the retry fixes it', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => (attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items)),
    });

    const result = await h.run();

    expect(result.exitCode).toBe(ExitCode.Sent);
    expect(result.record).toMatchObject({ status: 'sent', winner: WRITER_A });
    expect(result.record.drafts).toEqual([{ writer: WRITER_A, passed: true, rejectedBy: [] }]);
    expectValidRecord(result.record);
    expect(h.callsOf(WRITER_A)).toHaveLength(2);
    for (const delivery of h.deliveries) expect(delivery.digests).toHaveLength(1);
    expect(result.markdown).not.toContain('evil.example');
    expect(h.artifact('digest.md')).toBe(result.markdown);
    expect(h.store.isLocked).toBe(false);
  });

  it('puts the first attempt problems in the retry prompt, wrapped as untrusted data', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => (attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items)),
    });

    await h.run({ dryRun: true });

    const [first, retry] = h.model.generateCalls;
    expect(first?.prompt).not.toContain('evil.example');
    const start = retry?.prompt.indexOf(`${DATA_OPEN} check-problems>>>`) ?? -1;
    expect(start).toBeGreaterThan(0);
    expect(retry?.prompt.slice(start)).toContain(
      '- Unknown URL not in collected items: [url removed]',
    );
    expect(retry?.prompt).not.toContain('evil.example');
    expect(retry?.system).toContain(UNTRUSTED_DATA_RULE);
    expect(retry?.system).toBe(first?.system);
  });

  it('keeps the failed attempt in drafts.json and logs it before the retry', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => (attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items)),
    });

    await h.run({ dryRun: true });

    const file = h.draftsFile();
    expect(file.rejections).toEqual([
      { writer: WRITER_A, attempt: 1, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
    ]);
    expect(JSON.stringify(file.drafts)).not.toContain('evil.example');
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'info', message: 'Retrying writers after the checks' }),
    );
  });

  it('retries every rejected writer once, the last writer first, each with its own problems', async () => {
    const h = setup({
      reply: ({ writer, attempt, items }) => {
        if (attempt === 2) return bodyFor(items);
        return writer === WRITER_A ? withBadLink(bodyFor(items)) : withTooManyWords(bodyFor(items));
      },
    });

    const result = await h.run({ dryRun: true });

    expect(h.calls.map((call) => `${call.writer}#${call.attempt}`)).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
      `${WRITER_B}#2`,
      `${WRITER_A}#2`,
    ]);
    expect(h.callsOf(WRITER_A)[1]?.prompt).toContain('Unknown URL not in collected items');
    expect(h.callsOf(WRITER_A)[1]?.prompt).not.toContain('words, got');
    expect(h.callsOf(WRITER_B)[1]?.prompt).toContain('words, got');
    expect(h.callsOf(WRITER_B)[1]?.prompt).not.toContain('evil.example');
    expect(result.record.status).toBe('dry-run');
    expect(result.record.drafts.map((draft) => draft.passed)).toEqual([true, true]);
    expect(h.model.decideCalls.filter((call) => call.role === 'judge')).toHaveLength(2);
  });

  it('does not retry when at least one draft passes', async () => {
    const h = setup({
      reply: ({ writer, items }) =>
        writer === WRITER_A ? withBadLink(bodyFor(items)) : bodyFor(items),
    });

    const result = await h.run({ dryRun: true });

    expect(h.calls).toHaveLength(2);
    expect(result.record).toMatchObject({ status: 'dry-run', winner: WRITER_B });
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['linkCheck'] },
      { writer: WRITER_B, passed: true, rejectedBy: [] },
    ]);
  });

  it('retries at most once per writer, then blocks with the last attempt as the reason', async () => {
    const h = setup({
      reply: ({ writer, attempt, items }) =>
        writer === WRITER_A || attempt === 1
          ? withBadLink(bodyFor(items))
          : withTooManyWords(bodyFor(items)),
    });

    const result = await h.run();

    expect(h.callsOf(WRITER_A)).toHaveLength(2);
    expect(h.callsOf(WRITER_B)).toHaveLength(2);
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['linkCheck'] },
      { writer: WRITER_B, passed: false, rejectedBy: ['formatCheck'] },
    ]);
    expect(h.draftsFile().rejections.map((r) => `${r.writer}#${r.attempt}`)).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
      `${WRITER_A}#2`,
      `${WRITER_B}#2`,
    ]);
    expect(h.deliveries.flatMap((d) => d.digests)).toEqual([]);
  });

  it('takes the one draft that passes after a retry, without a judge', async () => {
    const h = setup({
      reply: ({ writer, attempt, items }) =>
        attempt === 1 || writer === WRITER_B ? withBadLink(bodyFor(items)) : bodyFor(items),
    });

    const result = await h.run({ dryRun: true });

    expect(result.record).toMatchObject({ status: 'dry-run', winner: WRITER_A });
    expect(result.record.drafts[1]).toEqual({
      writer: WRITER_B,
      passed: false,
      rejectedBy: ['linkCheck'],
    });
    expect(h.model.decideCalls.filter((call) => call.role === 'judge')).toEqual([]);
  });

  it('merges a mixed outcome: one retry fails, one succeeds, one writer has no draft', async () => {
    const profile = { ...PROFILE, writers: [WRITER_A, WRITER_B, WRITER_C], judge: null };
    const h = setup({
      profile,
      reply: ({ writer, attempt, items }) => {
        if (writer === WRITER_C) throw new Error('out of memory');
        if (attempt === 1) return withBadLink(bodyFor(items));
        if (writer === WRITER_A) throw new Error('model timed out');
        return bodyFor(items);
      },
    });

    const result = await h.run({ dryRun: true });

    expect(h.calls.map((call) => `${call.writer}#${call.attempt}`)).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
      `${WRITER_C}#1`,
      `${WRITER_B}#2`,
      `${WRITER_A}#2`,
    ]);
    expect(result.record).toMatchObject({ status: 'dry-run', winner: WRITER_B });
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['linkCheck'] },
      { writer: WRITER_B, passed: true, rejectedBy: [] },
      { writer: WRITER_C, passed: false, rejectedBy: ['write'] },
    ]);
    const file = h.draftsFile();
    expect(file.drafts.map((draft) => draft.writer)).toEqual([WRITER_A, WRITER_B]);
    expect(file.rejections.map((r) => `${r.writer}#${r.attempt}`)).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
    ]);
    expect(file.failures.map((failure) => [failure.writer, failure.retry])).toEqual([
      [WRITER_C, undefined],
      [WRITER_A, true],
    ]);
  });

  it('keeps the format problems in view when a draft also has many bad links', async () => {
    const urls = Array.from({ length: MAX_PROBLEMS + 3 }, (_, i) => `https://evil.example/${i}`);
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => {
        const body = withTooManyWords(bodyFor(items));
        return attempt === 1 ? withBadLink(body, urls.join(' and ')) : bodyFor(items);
      },
    });

    await h.run({ dryRun: true });

    const [line] = h.warnings('Draft failed the checks');
    expect(line?.fields.rejectedBy).toEqual(['linkCheck', 'formatCheck']);
    const logged = line?.fields.problems as string[];
    expect(logged[0]).toMatch(/^Expected under 500 words, got \d+/);
    expect(logged).toHaveLength(MAX_PROBLEMS + 1);
    expect(h.callsOf(WRITER_A)[1]?.prompt).toContain('Expected under 500 words');
  });

  it('keeps the first rejection, and does not retry again, when the retry call itself fails', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => {
        if (attempt === 2) throw new Error('model timed out');
        return withBadLink(bodyFor(items));
      },
    });

    const result = await h.run();

    expect(h.callsOf(WRITER_A)).toHaveLength(2);
    expect(result.record.status).toBe('blocked');
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['linkCheck'] },
    ]);
    const file = h.draftsFile();
    expect(file.failures).toEqual([
      {
        writer: WRITER_A,
        error: expect.stringContaining('model timed out') as string,
        retry: true,
      },
    ]);
    expect(file.drafts.map((draft) => draft.writer)).toEqual([WRITER_A]);
  });

  it('does not retry a writer that produced no draft', async () => {
    const h = setup({
      reply: ({ writer, attempt, items }) => {
        if (writer === WRITER_A) throw new Error('out of memory');
        return attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items);
      },
    });

    const result = await h.run({ dryRun: true });

    expect(h.callsOf(WRITER_A)).toHaveLength(1);
    expect(h.callsOf(WRITER_B)).toHaveLength(2);
    expect(result.record).toMatchObject({ status: 'dry-run', winner: WRITER_B });
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['write'] },
      { writer: WRITER_B, passed: true, rejectedBy: [] },
    ]);
  });

  it('makes no retry call when every writer failed to produce a draft', async () => {
    const h = setup({
      reply: () => {
        throw new Error('out of memory');
      },
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(2);
    expect(result.record).toMatchObject({ status: 'failed', error: { step: 'write' } });
  });

  it('runs the output guards on the retried draft, not on the rejected one', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => (attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items)),
    });

    await h.run({ dryRun: true });

    for (const guard of h.outputGuards) {
      expect(guard.calls).toHaveLength(1);
      expect(JSON.stringify(guard.calls[0])).not.toContain('evil.example');
    }
  });

  it('blocks with the guard as the reason when a guard flags the retried draft', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => (attempt === 1 ? withBadLink(bodyFor(items)) : bodyFor(items)),
      flagOutput: () => true,
    });

    const result = await h.run();

    expect(result.record.status).toBe('blocked');
    expect(result.record.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['graniteGroundedness'] },
    ]);
  });

  it('applies the same deterministic fixes to a retried draft, such as em dashes', async () => {
    const h = setup({
      profile: SINGLE_WRITER,
      reply: ({ attempt, items }) => {
        if (attempt === 1) return withBadLink(bodyFor(items));
        const body = bodyFor(items);
        return { ...body, headline: `Runners ${EM_DASH} and gateways ${EM_DASH} moved` };
      },
    });

    const result = await h.run({ dryRun: true });

    expect(result.record.status).toBe('dry-run');
    expect(result.markdown).toContain('# Runners, and gateways, moved');
    expect(result.markdown).not.toContain(EM_DASH);
  });
});
