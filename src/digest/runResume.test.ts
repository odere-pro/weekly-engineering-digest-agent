// Resuming a partly delivered week (W2-08), moved out of runDigest.ts by W5-06 (F58).
import { describe, expect, it } from 'vitest';
import {
  loadPartDelivery,
  resumeDelivery,
  type PartDelivery,
  type ResumeContext,
} from './runResume';
import { RunRecordSchema, type RunRecord } from '../store/runRecord';
import { type DeliveryId } from '../delivery/deliveryId';
import type { Clock } from '../shared/clock';
import type { LogFields, Logger, Tracer } from '../shared/telemetry';
import { makeConfig, makeRunRecord } from '../../test/builders';
import { CapturingDelivery, MemoryRunStore, fixedClock } from '../../test/fakes';

const WEEK = '2026-W42';
const NOW = '2026-10-16T08:00:00Z';
const HEADLINE = 'Runners and gateways moved this week';
const URLS = ['https://example.com/runner-1', 'https://example.com/runner-2'];
const SOURCES = URLS.map((url) => `[Source](${url})`).join('\n\n');
// The layout a run saved before W8-02; runResume.view.test.ts covers the current one.
const SAVED = `# ${HEADLINE}\n\n_Week ${WEEK}_\n\n## 1. Runner\n\n${SOURCES}\n`;
const REFUSAL = 'run with --force to send a new digest to every channel';

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

/** A clock that returns each instant once, then the last one. */
function steppingClock(...instants: string[]): Clock {
  const queue = instants.map((instant) => new Date(instant));
  return { now: () => (queue.length > 1 ? queue.shift() : queue[0]) ?? new Date(NOW) };
}

interface Span {
  name: string;
  attributes: LogFields;
  /** True when the span's function threw, which marks a span as an error in a real tracer. */
  failed: boolean;
}

function setup(
  channels: readonly DeliveryId[] = ['markdown', 'email', 'slack'],
  clock?: Clock,
  tracerError?: Error,
) {
  const store = new MemoryRunStore();
  const deliveries = channels.map((id) => new CapturingDelivery(id));
  const logs: LogLine[] = [];
  const spans: Span[] = [];
  const tracer: Tracer = {
    span: async (name, attributes, fn) => {
      if (tracerError) throw tracerError;
      const span: Span = { name, attributes, failed: false };
      spans.push(span);
      try {
        return await fn();
      } catch (error) {
        span.failed = true;
        throw error;
      }
    },
  };
  const ctx: ResumeContext = {
    weekId: WEEK,
    dryRun: false,
    startedAt: new Date(NOW),
    logger: recordingLogger(logs),
    deps: { store, deliveries, config: makeConfig(), clock: clock ?? fixedClock(NOW), tracer },
  };
  const channel = (id: DeliveryId): CapturingDelivery => {
    const found = deliveries.find((delivery) => delivery.id === id);
    if (!found) throw new Error(`No ${id} channel`);
    return found;
  };
  return { ctx, store, deliveries, channel, logs, spans };
}

type Harness = ReturnType<typeof setup>;

function failedAfterMarkdown(overrides: Partial<RunRecord> = {}): RunRecord {
  return makeRunRecord({
    runId: WEEK,
    status: 'failed',
    timings: [{ step: 'collect', ms: 1200 }],
    sentUrls: URLS,
    deliveredTo: ['markdown'],
    winner: 'writer-a:31b',
    error: { step: 'deliver', message: 'Delivery failed on email (SMTP 451)' },
    ...overrides,
  });
}

/** The saved state of a run that reached markdown only, with its digest.md on disk. */
function savedWeek(
  h: Harness,
  overrides: Partial<RunRecord> = {},
  markdown: string | null = SAVED,
) {
  const previous = failedAfterMarkdown(overrides);
  h.store.records.set(WEEK, previous);
  if (markdown !== null) h.store.artifacts.set(`${WEEK}/digest.md`, markdown);
  return previous;
}

async function partOf(h: Harness, previous: RunRecord): Promise<PartDelivery> {
  const part = await loadPartDelivery(h.ctx, previous);
  if (!part) throw new Error('Expected a partly delivered week');
  return part;
}

const sentCounts = (h: Harness): number[] => h.deliveries.map((d) => d.digests.length);

describe('loadPartDelivery', () => {
  it.each<[string, RunRecord | undefined]>([
    ['there is no earlier record', undefined],
    ['the earlier run was sent', makeRunRecord({ status: 'sent', deliveredTo: ['markdown'] })],
    ['the earlier run failed before any channel', failedAfterMarkdown({ deliveredTo: undefined })],
    ['the earlier run reached an empty channel list', failedAfterMarkdown({ deliveredTo: [] })],
    ['the earlier run was blocked', makeRunRecord({ status: 'blocked', deliveredTo: ['email'] })],
  ])('finds nothing when %s', async (_name, previous) => {
    const h = setup();

    expect(await loadPartDelivery(h.ctx, previous)).toBeUndefined();
  });

  it('returns the record, its channels and the saved digest.md of a failed run that reached some', async () => {
    const h = setup();
    const previous = savedWeek(h);

    const part = await loadPartDelivery(h.ctx, previous);

    expect(part).toEqual({ previous, deliveredTo: ['markdown'], markdown: SAVED });
  });

  it('returns no markdown when digest.md is gone', async () => {
    const h = setup();
    const previous = savedWeek(h, {}, null);

    const part = await loadPartDelivery(h.ctx, previous);

    expect(part?.markdown).toBeUndefined();
  });
});

describe('resumeDelivery', () => {
  it('sends the saved digest to the missing channels only and seals the week sent', async () => {
    const h = setup();
    const previous = savedWeek(h);

    const result = await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(sentCounts(h)).toEqual([0, 1, 1]);
    expect(h.channel('email').digests).toEqual([
      { weekId: WEEK, subject: `Engineering digest ${WEEK}: ${HEADLINE}`, markdown: SAVED },
    ]);
    const { error: _error, ...kept } = previous;
    expect(result.record).toEqual({
      ...kept,
      status: 'sent',
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW).toISOString(),
      timings: [...previous.timings, { step: 'deliver', ms: 0 }],
      deliveredTo: ['markdown', 'email', 'slack'],
    });
    expect(RunRecordSchema.parse(result.record)).toEqual(result.record);
    expect(h.store.records.get(WEEK)).toEqual(result.record);
    expect(result.markdown).toBe(SAVED);
  });

  it('times the deliver step with the clock and traces it as a span of the run', async () => {
    const clock = steppingClock(NOW, '2026-10-16T08:00:02Z', '2026-10-16T08:00:03Z');
    const h = setup(undefined, clock);
    const previous = savedWeek(h);

    const result = await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(result.record.timings.at(-1)).toEqual({ step: 'deliver', ms: 2000 });
    expect(h.spans).toEqual([
      { name: 'deliver', attributes: { runId: WEEK, step: 'deliver' }, failed: false },
    ]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'Digest delivered',
        fields: expect.objectContaining({
          step: 'deliver',
          channels: ['email', 'slack'],
        }) as LogFields,
      }),
    );
  });

  it('keeps what a failed resume reached and fails the week at deliver', async () => {
    const h = setup();
    h.channel('slack').failWith = new Error('HTTP 500');
    const previous = savedWeek(h);

    const result = await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(result.record).toMatchObject({
      status: 'failed',
      deliveredTo: ['markdown', 'email'],
      error: {
        step: 'deliver',
        message: 'Delivery failed on slack (HTTP 500); delivered on markdown, email',
      },
    });
    expect(result.record.timings.map((timing) => timing.step)).toEqual(['collect', 'deliver']);
    expect(result.markdown).toBe(SAVED);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'Step failed' }),
    );
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        { weekId: WEEK, step: 'deliver', message: result.record.error?.message },
      ]);
    }
  });

  it('marks the deliver span as failed when a channel fails, so a trace shows the error', async () => {
    const h = setup();
    h.channel('slack').failWith = new Error('HTTP 500');
    const previous = savedWeek(h);

    await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(h.spans.map((span) => span.failed)).toEqual([true]);
  });

  it('marks the deliver span as failed when the saved digest is refused', async () => {
    const h = setup();
    const previous = savedWeek(h, {}, null);

    await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(h.spans.map((span) => span.failed)).toEqual([true]);
  });

  it('still records the failed week, keeping its channels, when the tracer itself breaks', async () => {
    const h = setup(undefined, undefined, new Error('collector down'));
    const previous = savedWeek(h);

    const result = await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(sentCounts(h)).toEqual([0, 0, 0]);
    expect(result.record).toMatchObject({
      status: 'failed',
      deliveredTo: ['markdown'],
      error: { step: 'deliver', message: 'collector down' },
    });
    expect(h.store.records.get(WEEK)).toEqual(result.record);
  });

  it('does not touch the stored sent URLs of the earlier run', async () => {
    const h = setup();
    const previous = savedWeek(h);

    const result = await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(result.record.sentUrls).toEqual(previous.sentUrls);
  });

  it.each<[string, string | null, string]>([
    ['is gone', null, 'The partly delivered digest.md is gone'],
    ['is empty', '', 'digest.md no longer matches the digest markdown got'],
    [
      'links to other items',
      SAVED.replace('runner-2', 'runner-9'),
      'digest.md no longer matches the digest markdown got',
    ],
    [
      'drops an item',
      SAVED.replace(`[Source](${URLS[1]})`, ''),
      'digest.md no longer matches the digest markdown got',
    ],
  ])(
    'sends nothing and fails at deliver when the saved digest %s',
    async (_name, saved, reason) => {
      const h = setup();
      const previous = savedWeek(h, {}, saved);

      const result = await resumeDelivery(h.ctx, await partOf(h, previous));

      expect(sentCounts(h)).toEqual([0, 0, 0]);
      expect(result.record).toMatchObject({
        status: 'failed',
        deliveredTo: ['markdown'],
        error: { step: 'deliver', message: `${reason}; ${REFUSAL}` },
      });
      expect(result.markdown).toBeUndefined();
    },
  );

  it.each<[string, string | null]>([
    ['gone', null],
    ['replaced by another digest', SAVED.replace('runner-2', 'runner-9')],
  ])(
    'seals the week sent without a check when no channel is missing and digest.md is %s',
    async (_name, saved) => {
      const h = setup(['markdown']);
      const previous = savedWeek(h, { deliveredTo: ['markdown', 'slack'] }, saved);

      const result = await resumeDelivery(h.ctx, await partOf(h, previous));

      expect(sentCounts(h)).toEqual([0]);
      expect(result.record).toMatchObject({ status: 'sent', deliveredTo: ['markdown', 'slack'] });
      expect(result.record.error).toBeUndefined();
      expect(result.markdown).toBeUndefined();
      expect(result.record.timings.at(-1)).toEqual({ step: 'deliver', ms: 0 });
    },
  );

  it('sends nothing and fails at deliver when the run was told to stop (F46)', async () => {
    const h = setup();
    const previous = savedWeek(h);
    const controller = new AbortController();
    controller.abort(new Error('scheduler timeout after 2h'));

    const result = await resumeDelivery(
      { ...h.ctx, signal: controller.signal },
      await partOf(h, previous),
    );

    expect(sentCounts(h)).toEqual([0, 0, 0]);
    expect(result.record).toMatchObject({
      status: 'failed',
      deliveredTo: ['markdown'],
      error: {
        step: 'deliver',
        message: 'Run aborted before the deliver step: scheduler timeout after 2h',
      },
    });
    expect(result.markdown).toBeUndefined();
  });

  it('still seals a week with no missing channel when the run was told to stop', async () => {
    const h = setup(['markdown']);
    const previous = savedWeek(h);
    const controller = new AbortController();
    controller.abort();

    const result = await resumeDelivery(
      { ...h.ctx, signal: controller.signal },
      await partOf(h, previous),
    );

    expect(result.record).toMatchObject({ status: 'sent', deliveredTo: ['markdown'] });
  });

  it('builds a plain subject when the saved digest has no headline line', async () => {
    const h = setup();
    const previous = savedWeek(h, {}, `## Not the headline\n\n${SOURCES}\n`);

    await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(h.channel('email').digests[0]?.subject).toBe(`Engineering digest ${WEEK}`);
  });

  it('logs which channels it resumes', async () => {
    const h = setup();
    const previous = savedWeek(h);

    await resumeDelivery(h.ctx, await partOf(h, previous));

    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Resuming the delivery of the saved digest',
        fields: expect.objectContaining({
          deliveredTo: ['markdown'],
          channels: ['email', 'slack'],
        }) as LogFields,
      }),
    );
  });
});
