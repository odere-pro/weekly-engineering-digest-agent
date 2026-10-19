// Why a draft was rejected (W5-06, F6) and the one writer retry when no draft passes the link or
// format check (F1), tested on `writeCheckedStep` itself. Moved from `digest/runDigest.retry.test.ts`.
import { describe, expect, it } from 'vitest';
import type { Digest } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import type { LogFields, Logger } from '../shared/telemetry';
import { DATA_OPEN, UNTRUSTED_DATA_RULE } from '../shared/untrusted';
import { writeCheckedStep, type CheckedWriteDeps } from './write';
import { MAX_PROBLEMS, PROBLEM_MAX_CHARS } from './writePrompt';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider } from '../../test/fakes';

const AREA = 'AI models and tooling';
const WRITER_A = 'writer-a:31b';
const WRITER_B = 'writer-b:30b';
const WRITER_C = 'writer-c:9b';
const EVIL = 'https://evil.example/payload';
const EVIL_PROBLEM = `Unknown URL not in collected items: ${EVIL}`;
const EM_DASH = '—';

type DigestBody = Omit<Digest, 'weekId'>;

interface WriterCall {
  writer: string;
  /** 1 for the writer's first call, 2 for its retry. */
  attempt: number;
  prompt: string;
}

interface Scenario {
  writers?: readonly string[];
  /** The writer's reply; throw to fail the call. A string is sent as is. */
  reply?: (call: WriterCall) => DigestBody | string;
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

/** The items every writer is given, and so the items every body is about. */
const ITEMS: readonly ScoredItem[] = Array.from({ length: 4 }, (_, index) =>
  makeScoredItem({ title: `Runner ${index + 1}.0 ships` }),
);

/** What a writer replies when it follows the prompt: one entry per item, all valid. */
function bodyFor(): DigestBody {
  return {
    headline: 'Runners and gateways moved this week',
    intro: 'These releases change how teams build and ship.',
    items: ITEMS.map((item) =>
      makeDigestItem(item, {
        area: AREA,
        summary: `${item.title} with faster builds.`,
        whyItMatters: 'Teams can cut CI time without new hardware.',
        urgency: 'worth-a-look',
        action: 'Relevant if you run it.',
      }),
    ),
  };
}

/** The body with an unknown URL in the first item's summary: the link check rejects it. */
function withBadLink(body: DigestBody, url = EVIL): DigestBody {
  const [first, ...rest] = body.items;
  return { ...body, items: [{ ...first!, summary: `Details at ${url} today.` }, ...rest] };
}

/**
 * The body with a headline far over the word limit: the format check rejects it. The headline is
 * rendered in every layout, and it has no limit of its own, so the word count is the only problem.
 */
function withTooManyWords(body: DigestBody): DigestBody {
  return { ...body, headline: 'word '.repeat(600).trim() };
}

function setup(scenario: Scenario = {}) {
  const logs: LogLine[] = [];
  const calls: WriterCall[] = [];
  const attempts = new Map<string, number>();
  const model = new FakeModelProvider({
    generate: (request) => {
      const writer = request.model ?? '';
      const attempt = (attempts.get(writer) ?? 0) + 1;
      attempts.set(writer, attempt);
      const call = { writer, attempt, prompt: request.prompt };
      calls.push(call);
      const reply = scenario.reply ? scenario.reply(call) : bodyFor();
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  });
  const deps: CheckedWriteDeps = {
    model,
    writers: scenario.writers ?? [WRITER_A],
    focusAreas: [AREA, 'Platform engineering'],
    weekId: '2026-W42',
    logger: recordingLogger(logs),
    collected: ITEMS,
    disabledGuards: [],
    topN: 5,
  };
  return {
    run: () => writeCheckedStep(ITEMS, deps),
    model,
    logs,
    calls,
    callsOf: (writer: string) => calls.filter((call) => call.writer === writer),
    order: () => calls.map((call) => `${call.writer}#${call.attempt}`),
    warnings: (message: string) =>
      logs.filter((line) => line.level === 'warn' && line.message === message),
  };
}

const TWO_WRITERS = [WRITER_A, WRITER_B] as const;
const tag = (r: { writer: string; attempt: number }): string => `${r.writer}#${r.attempt}`;

describe('writeCheckedStep: why a draft was rejected (F6)', () => {
  it('logs the link check problems of a rejected draft at warn', async () => {
    const h = setup({ reply: () => withBadLink(bodyFor()) });

    await h.run();

    expect(h.warnings('Draft failed the checks')[0]).toEqual({
      level: 'warn',
      message: 'Draft failed the checks',
      fields: { writer: WRITER_A, attempt: 1, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
    });
  });

  it('logs the format check problems too, including the word count', async () => {
    const h = setup({ reply: () => withTooManyWords(bodyFor()) });

    await h.run();

    const [line] = h.warnings('Draft failed the checks');
    expect(line?.fields).toMatchObject({ rejectedBy: ['formatCheck'] });
    expect(line?.fields.problems).toEqual([
      expect.stringMatching(/^Expected under 500 words, got \d+/),
    ]);
  });

  it('returns the problems of every rejected attempt next to the final draft', async () => {
    const h = setup({ reply: () => withBadLink(bodyFor()) });

    const result = await h.run();

    expect(result.rejections).toEqual([
      { writer: WRITER_A, attempt: 1, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
      { writer: WRITER_A, attempt: 2, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
    ]);
    expect(result.checked.map((entry) => entry.draft.writer)).toEqual([WRITER_A]);
    expect(result.writeFailures).toEqual([]);
    expect(result.retryFailures).toEqual([]);
  });

  it('returns an empty list, and logs nothing, when every draft passed', async () => {
    const h = setup();

    const result = await h.run();

    expect(result.rejections).toEqual([]);
    expect(result.checked.map((entry) => entry.rejectedBy)).toEqual([[]]);
    expect(h.warnings('Draft failed the checks')).toEqual([]);
  });

  it('bounds the problems: the first few, each cut short, and a count of the rest', async () => {
    const urls = Array.from({ length: MAX_PROBLEMS + 7 }, (_, i) => `https://evil.example/${i}`);
    const long = `https://evil.example/${'x'.repeat(900)}`;
    const h = setup({
      reply: () => withBadLink(bodyFor(), [long, ...urls].join(' and ')),
    });

    const result = await h.run();

    const [line] = h.warnings('Draft failed the checks');
    const logged = line?.fields.problems as string[];
    expect(logged).toHaveLength(MAX_PROBLEMS + 1);
    expect(logged.slice(0, MAX_PROBLEMS).every((p) => p.length <= PROBLEM_MAX_CHARS)).toBe(true);
    expect(logged.at(-1)).toBe(`and ${urls.length + 1 - MAX_PROBLEMS} more problems`);
    expect(result.rejections[0]?.problems).toEqual(logged);
  });

  it('keeps the whole problem list on the checked draft, which only the consumers bound', async () => {
    const urls = Array.from({ length: MAX_PROBLEMS + 7 }, (_, i) => `https://evil.example/${i}`);
    const h = setup({ reply: () => withBadLink(bodyFor(), urls.join(' and ')) });

    const result = await h.run();

    expect(result.checked[0]?.problems).toHaveLength(MAX_PROBLEMS + 7);
  });

  it('keeps the rejected url out of the final Markdown and the final draft', async () => {
    const h = setup({
      reply: ({ attempt }) => (attempt === 1 ? withBadLink(bodyFor()) : bodyFor()),
    });

    const result = await h.run();

    expect(JSON.stringify(result.checked)).not.toContain('evil.example');
  });
});

describe('writeCheckedStep: one retry when no draft passes the checks (F1)', () => {
  it('passes a week whose only draft fails the link check once, when the retry fixes it', async () => {
    const h = setup({
      reply: ({ attempt }) => (attempt === 1 ? withBadLink(bodyFor()) : bodyFor()),
    });

    const result = await h.run();

    expect(h.callsOf(WRITER_A)).toHaveLength(2);
    expect(result.checked).toHaveLength(1);
    expect(result.checked[0]).toMatchObject({ rejectedBy: [], problems: [] });
    expect(result.checked[0]?.markdown).not.toContain('evil.example');
    expect(result.retryFailures).toEqual([]);
  });

  it('puts the first attempt problems in the retry prompt, wrapped as untrusted data', async () => {
    const h = setup({
      reply: ({ attempt }) => (attempt === 1 ? withBadLink(bodyFor()) : bodyFor()),
    });

    await h.run();

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

  it('keeps the failed attempt in the rejections and logs the retry before it starts', async () => {
    const h = setup({
      reply: ({ attempt }) => (attempt === 1 ? withBadLink(bodyFor()) : bodyFor()),
    });

    const result = await h.run();

    expect(result.rejections).toEqual([
      { writer: WRITER_A, attempt: 1, rejectedBy: ['linkCheck'], problems: [EVIL_PROBLEM] },
    ]);
    expect(h.logs).toContainEqual({
      level: 'info',
      message: 'Retrying writers after the checks',
      fields: { writers: [WRITER_A] },
    });
  });

  it('retries every rejected writer once, the last writer first, each with its own problems', async () => {
    const h = setup({
      writers: TWO_WRITERS,
      reply: ({ writer, attempt }) => {
        if (attempt === 2) return bodyFor();
        return writer === WRITER_A ? withBadLink(bodyFor()) : withTooManyWords(bodyFor());
      },
    });

    const result = await h.run();

    expect(h.order()).toEqual([`${WRITER_A}#1`, `${WRITER_B}#1`, `${WRITER_B}#2`, `${WRITER_A}#2`]);
    expect(h.callsOf(WRITER_A)[1]?.prompt).toContain('Unknown URL not in collected items');
    expect(h.callsOf(WRITER_A)[1]?.prompt).not.toContain('words, got');
    expect(h.callsOf(WRITER_B)[1]?.prompt).toContain('words, got');
    expect(h.callsOf(WRITER_B)[1]?.prompt).not.toContain('evil.example');
    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_A, []],
      [WRITER_B, []],
    ]);
    // The log names the writers in the order of their drafts, though the calls run in reverse.
    expect(h.logs).toContainEqual({
      level: 'info',
      message: 'Retrying writers after the checks',
      fields: { writers: [WRITER_A, WRITER_B] },
    });
  });

  it('does not retry when at least one draft passes', async () => {
    const h = setup({
      writers: TWO_WRITERS,
      reply: ({ writer }) => (writer === WRITER_A ? withBadLink(bodyFor()) : bodyFor()),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(2);
    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_A, ['linkCheck']],
      [WRITER_B, []],
    ]);
    expect(result.rejections.map(tag)).toEqual([`${WRITER_A}#1`]);
  });

  it('retries at most once per writer, and keeps the last attempt as the draft', async () => {
    const h = setup({
      writers: TWO_WRITERS,
      reply: ({ writer, attempt }) =>
        writer === WRITER_A || attempt === 1 ? withBadLink(bodyFor()) : withTooManyWords(bodyFor()),
    });

    const result = await h.run();

    expect(h.callsOf(WRITER_A)).toHaveLength(2);
    expect(h.callsOf(WRITER_B)).toHaveLength(2);
    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_A, ['linkCheck']],
      [WRITER_B, ['formatCheck']],
    ]);
    expect(result.rejections.map(tag)).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
      `${WRITER_A}#2`,
      `${WRITER_B}#2`,
    ]);
  });

  it('takes the one draft that passes after a retry', async () => {
    const h = setup({
      writers: TWO_WRITERS,
      reply: ({ writer, attempt }) =>
        attempt === 1 || writer === WRITER_B ? withBadLink(bodyFor()) : bodyFor(),
    });

    const result = await h.run();

    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_A, []],
      [WRITER_B, ['linkCheck']],
    ]);
  });

  it('merges a mixed outcome: one retry fails, one succeeds, one writer has no draft', async () => {
    const h = setup({
      writers: [WRITER_A, WRITER_B, WRITER_C],
      reply: ({ writer, attempt }) => {
        if (writer === WRITER_C) throw new Error('out of memory');
        if (attempt === 1) return withBadLink(bodyFor());
        if (writer === WRITER_A) throw new Error('model timed out');
        return bodyFor();
      },
    });

    const result = await h.run();

    expect(h.order()).toEqual([
      `${WRITER_A}#1`,
      `${WRITER_B}#1`,
      `${WRITER_C}#1`,
      `${WRITER_B}#2`,
      `${WRITER_A}#2`,
    ]);
    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_A, ['linkCheck']],
      [WRITER_B, []],
    ]);
    expect(result.rejections.map(tag)).toEqual([`${WRITER_A}#1`, `${WRITER_B}#1`]);
    expect(result.writeFailures).toEqual([
      { writer: WRITER_C, error: expect.stringContaining('out of memory') as string },
    ]);
    expect(result.retryFailures).toEqual([
      { writer: WRITER_A, error: expect.stringContaining('model timed out') as string },
    ]);
  });

  it('keeps the format problems in view when a draft also has many bad links', async () => {
    const urls = Array.from({ length: MAX_PROBLEMS + 3 }, (_, i) => `https://evil.example/${i}`);
    const h = setup({
      reply: ({ attempt }) => {
        const body = withTooManyWords(bodyFor());
        return attempt === 1 ? withBadLink(body, urls.join(' and ')) : bodyFor();
      },
    });

    await h.run();

    const [line] = h.warnings('Draft failed the checks');
    expect(line?.fields.rejectedBy).toEqual(['linkCheck', 'formatCheck']);
    const logged = line?.fields.problems as string[];
    expect(logged[0]).toMatch(/^Expected under 500 words, got \d+/);
    expect(logged).toHaveLength(MAX_PROBLEMS + 1);
    expect(h.callsOf(WRITER_A)[1]?.prompt).toContain('Expected under 500 words');
  });

  it('keeps the first rejection, and does not retry again, when the retry call itself fails', async () => {
    const h = setup({
      reply: ({ attempt }) => {
        if (attempt === 2) throw new Error('model timed out');
        return withBadLink(bodyFor());
      },
    });

    const result = await h.run();

    expect(h.callsOf(WRITER_A)).toHaveLength(2);
    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_A, ['linkCheck']],
    ]);
    expect(result.retryFailures).toEqual([
      { writer: WRITER_A, error: expect.stringContaining('model timed out') as string },
    ]);
    expect(result.writeFailures).toEqual([]);
    expect(result.rejections.map(tag)).toEqual([`${WRITER_A}#1`]);
  });

  it('does not retry a writer that produced no draft', async () => {
    const h = setup({
      writers: TWO_WRITERS,
      reply: ({ writer, attempt }) => {
        if (writer === WRITER_A) throw new Error('out of memory');
        return attempt === 1 ? withBadLink(bodyFor()) : bodyFor();
      },
    });

    const result = await h.run();

    expect(h.callsOf(WRITER_A)).toHaveLength(1);
    expect(h.callsOf(WRITER_B)).toHaveLength(2);
    expect(result.checked.map((entry) => [entry.draft.writer, entry.rejectedBy])).toEqual([
      [WRITER_B, []],
    ]);
    expect(result.writeFailures.map((failure) => failure.writer)).toEqual([WRITER_A]);
  });

  it('makes no retry call when every writer failed to produce a draft', async () => {
    const h = setup({
      writers: TWO_WRITERS,
      reply: () => {
        throw new Error('out of memory');
      },
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(2);
    expect(result.checked).toEqual([]);
    expect(result.rejections).toEqual([]);
    expect(result.writeFailures.map((failure) => failure.writer)).toEqual(TWO_WRITERS);
    expect(h.logs.some((line) => line.message === 'Retrying writers after the checks')).toBe(false);
  });

  it('applies the same deterministic fixes to a retried draft, such as em dashes', async () => {
    const h = setup({
      reply: ({ attempt }) => {
        if (attempt === 1) return withBadLink(bodyFor());
        return { ...bodyFor(), headline: `Runners ${EM_DASH} and gateways ${EM_DASH} moved` };
      },
    });

    const result = await h.run();

    expect(result.checked[0]?.rejectedBy).toEqual([]);
    expect(result.checked[0]?.markdown).toContain('_Runners, and gateways, moved_');
    expect(result.checked[0]?.markdown).not.toContain(EM_DASH);
  });
});
