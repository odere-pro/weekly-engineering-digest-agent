import { describe, expect, it, vi } from 'vitest';
import { guardOutputStep, type GuardOutputDeps, type GuardOutputOutput } from './guardOutput';
import type { Draft, GuardCheckId, GuardVerdict, Item } from '../domain/schemas';
import type { OutputGuard } from './Guard';
import { DigestError } from '../shared/errors';
import { makeConfig, makeDraft, makeItem } from '../../test/builders';
import { FakeOutputGuard, noopLogger } from '../../test/fakes';

type OutputConfig = GuardOutputDeps['config'];

function outputConfig(
  overrides: Partial<Omit<OutputConfig, 'checks'>> & {
    checks?: Partial<OutputConfig['checks']>;
  } = {},
): OutputConfig {
  const base = makeConfig().guards.output;
  return { ...base, ...overrides, checks: { ...base.checks, ...overrides.checks } };
}

function makeTestLogger() {
  const warn = vi.fn();
  return { logger: { ...noopLogger, warn }, warn };
}

function makeDeps(
  guards: readonly OutputGuard[],
  config: OutputConfig = outputConfig(),
): GuardOutputDeps {
  return { guards, config, logger: noopLogger };
}

const SOURCES: readonly Item[] = [makeItem(), makeItem()];

function drafts(count: number): Draft[] {
  return Array.from({ length: count }, (_, index) => makeDraft(SOURCES, `writer-${index + 1}`));
}

const flagging = (...flagged: readonly Draft[]) => {
  const writers = new Set(flagged.map((draft) => draft.writer));
  return (draft: Draft) => writers.has(draft.writer);
};

const writers = (list: readonly Draft[]): string[] => list.map((draft) => draft.writer);

/** Records `${guardId}:${writer}` in a log shared by several guards, to assert call order. */
class RecordingGuard implements OutputGuard {
  constructor(
    readonly id: GuardCheckId,
    private readonly log: string[],
    private readonly flag: (draft: Draft) => boolean = () => false,
  ) {}

  checkDraft(draft: Draft): Promise<GuardVerdict> {
    this.log.push(`${this.id}:${draft.writer}`);
    return Promise.resolve({ check: this.id, flagged: this.flag(draft) });
  }
}

/** Remembers the `sources` argument of every call. */
class SourceCapturingGuard implements OutputGuard {
  readonly sources: (readonly Item[])[] = [];
  constructor(readonly id: GuardCheckId) {}

  checkDraft(_draft: Draft, sources: readonly Item[]): Promise<GuardVerdict> {
    this.sources.push(sources);
    return Promise.resolve({ check: this.id, flagged: false });
  }
}

class ThrowingGuard implements OutputGuard {
  readonly calls: Draft[] = [];
  constructor(
    readonly id: GuardCheckId,
    private readonly error: Error,
  ) {}

  checkDraft(draft: Draft): Promise<GuardVerdict> {
    this.calls.push(draft);
    return Promise.reject(this.error);
  }
}

/** Takes two microtask turns per call, so calls overlap whenever the step lets them. */
class OverlapGuard implements OutputGuard {
  peak = 0;
  private inFlight = 0;
  constructor(
    readonly id: GuardCheckId,
    private readonly flag: (draft: Draft) => boolean = () => false,
  ) {}

  async checkDraft(draft: Draft): Promise<GuardVerdict> {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    this.inFlight -= 1;
    return { check: this.id, flagged: this.flag(draft) };
  }
}

describe('guardOutputStep', () => {
  describe('mode any', () => {
    it('rejects a draft flagged by either guard and keeps the rest in input order', async () => {
      const [a, b, c, d] = drafts(4) as [Draft, Draft, Draft, Draft];
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(a));
      const clef = new FakeOutputGuard('clefRubric', flagging(c));

      const out = await guardOutputStep([a, b, c, d], SOURCES, makeDeps([granite, clef]));

      expect(writers(out.passed)).toEqual([b.writer, d.writer]);
      expect(writers(out.rejected.map((entry) => entry.draft))).toEqual([a.writer, c.writer]);
      expect(out.disabledChecks).toEqual([]);
    });

    it('lists rejected drafts in input order even when a later guard flags the earlier one', async () => {
      const [a, b, c] = drafts(3) as [Draft, Draft, Draft];
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(c));
      const clef = new FakeOutputGuard('clefRubric', flagging(a));

      const out = await guardOutputStep([a, b, c], SOURCES, makeDeps([granite, clef]));

      expect(writers(out.rejected.map((entry) => entry.draft))).toEqual([a.writer, c.writer]);
    });

    it('sends only the drafts guard A did not flag to guard B', async () => {
      const [a, b, c] = drafts(3) as [Draft, Draft, Draft];
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(a));
      const clef = new FakeOutputGuard('clefRubric');

      await guardOutputStep([a, b, c], SOURCES, makeDeps([granite, clef]));

      expect(granite.calls).toEqual([a, b, c]);
      expect(clef.calls).toEqual([b, c]);
    });
  });

  describe('mode all', () => {
    const config = outputConfig({ mode: 'all' });

    it('rejects only drafts flagged by every enabled guard', async () => {
      const [a, b, c, d] = drafts(4) as [Draft, Draft, Draft, Draft];
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(a, b));
      const clef = new FakeOutputGuard('clefRubric', flagging(b, c));

      const out = await guardOutputStep([a, b, c, d], SOURCES, makeDeps([granite, clef], config));

      expect(writers(out.passed)).toEqual([a.writer, c.writer, d.writer]);
      expect(writers(out.rejected.map((entry) => entry.draft))).toEqual([b.writer]);
    });

    it('sends only the drafts guard A flagged to guard B', async () => {
      const [a, b, c] = drafts(3) as [Draft, Draft, Draft];
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(b));
      const clef = new FakeOutputGuard('clefRubric');

      const out = await guardOutputStep([a, b, c], SOURCES, makeDeps([granite, clef], config));

      expect(granite.calls).toEqual([a, b, c]);
      expect(clef.calls).toEqual([b]);
      expect(out.rejected).toEqual([]);
    });
  });

  describe('sources', () => {
    it('passes the source items to every guard call', async () => {
      const granite = new SourceCapturingGuard('graniteGroundedness');
      const clef = new SourceCapturingGuard('clefRubric');

      await guardOutputStep(drafts(2), SOURCES, makeDeps([granite, clef]));

      expect(granite.sources).toEqual([SOURCES, SOURCES]);
      expect(clef.sources).toEqual([SOURCES, SOURCES]);
    });
  });

  describe('disabled checks', () => {
    it('reports a check switched off in config and never calls its guard', async () => {
      const list = drafts(2);
      const granite = new FakeOutputGuard('graniteGroundedness');
      const clef = new FakeOutputGuard('clefRubric');
      const config = outputConfig({ checks: { clefRubric: false } });

      const out = await guardOutputStep(list, SOURCES, makeDeps([granite, clef], config));

      expect(out.disabledChecks).toEqual(['clefRubric']);
      expect(clef.calls).toEqual([]);
      expect(granite.calls).toEqual(list);
    });

    it('reports every check and passes every draft when output guards are disabled', async () => {
      const list = drafts(3);
      const granite = new FakeOutputGuard('graniteGroundedness', () => true);
      const clef = new FakeOutputGuard('clefRubric', () => true);
      const config = outputConfig({ enabled: false });

      const out = await guardOutputStep(list, SOURCES, makeDeps([granite, clef], config));

      expect(out).toEqual<GuardOutputOutput>({
        passed: list,
        rejected: [],
        disabledChecks: ['graniteGroundedness', 'clefRubric'],
      });
      expect([...granite.calls, ...clef.calls]).toEqual([]);
    });

    it('reports an enabled check whose guard is missing and logs a warning', async () => {
      const [a, b] = drafts(2) as [Draft, Draft];
      const clef = new FakeOutputGuard('clefRubric', flagging(a));
      const { logger, warn } = makeTestLogger();

      const out = await guardOutputStep([a, b], SOURCES, {
        guards: [clef],
        config: outputConfig(),
        logger,
      });

      expect(out.disabledChecks).toEqual(['graniteGroundedness']);
      expect(writers(out.passed)).toEqual([b.writer]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('graniteGroundedness'), {
        check: 'graniteGroundedness',
      });
    });

    it('runs guards in config order, whatever order they were passed in', async () => {
      const [a, b] = drafts(2) as [Draft, Draft];
      const log: string[] = [];
      const clef = new RecordingGuard('clefRubric', log);
      const granite = new RecordingGuard('graniteGroundedness', log);

      await guardOutputStep([a, b], SOURCES, makeDeps([clef, granite]));

      expect(log).toEqual([
        `graniteGroundedness:${a.writer}`,
        `graniteGroundedness:${b.writer}`,
        `clefRubric:${a.writer}`,
        `clefRubric:${b.writer}`,
      ]);
    });

    it('ignores a guard that is not an output check', async () => {
      const list = drafts(2);
      const foreign = new FakeOutputGuard('clefPolicy', () => true);
      const granite = new FakeOutputGuard('graniteGroundedness');
      const clef = new FakeOutputGuard('clefRubric');

      const out = await guardOutputStep(list, SOURCES, makeDeps([foreign, granite, clef]));

      expect(foreign.calls).toEqual([]);
      expect(out.passed).toEqual(list);
      expect(out.disabledChecks).toEqual([]);
    });

    it('passes everything and runs nothing when no check is enabled', async () => {
      const list = drafts(2);
      const granite = new FakeOutputGuard('graniteGroundedness', () => true);
      const config = outputConfig({ checks: { graniteGroundedness: false, clefRubric: false } });

      const out = await guardOutputStep(list, SOURCES, makeDeps([granite], config));

      expect(out).toEqual<GuardOutputOutput>({
        passed: list,
        rejected: [],
        disabledChecks: ['graniteGroundedness', 'clefRubric'],
      });
      expect(granite.calls).toEqual([]);
    });

    it('passes everything in mode all too when no check is enabled', async () => {
      const list = drafts(2);
      const config = outputConfig({
        mode: 'all',
        checks: { graniteGroundedness: false, clefRubric: false },
      });

      const out = await guardOutputStep(list, SOURCES, makeDeps([], config));

      expect(out.passed).toEqual(list);
      expect(out.rejected).toEqual([]);
    });
  });

  describe('verdicts', () => {
    it('records the verdicts of every guard that looked at a rejected draft', async () => {
      const [a] = drafts(1) as [Draft];
      const granite = new FakeOutputGuard('graniteGroundedness');
      const clef = new FakeOutputGuard('clefRubric', flagging(a));

      const out = await guardOutputStep([a], SOURCES, makeDeps([granite, clef]));

      expect(out.rejected).toEqual([
        {
          draft: a,
          verdicts: [
            { check: 'graniteGroundedness', flagged: false },
            { check: 'clefRubric', flagged: true },
          ],
        },
      ]);
    });

    it('records every flagging verdict for a draft rejected by all guards', async () => {
      const [a] = drafts(1) as [Draft];
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(a));
      const clef = new FakeOutputGuard('clefRubric', flagging(a));

      const out = await guardOutputStep(
        [a],
        SOURCES,
        makeDeps([granite, clef], outputConfig({ mode: 'all' })),
      );

      expect(out.rejected[0]?.verdicts).toEqual([
        { check: 'graniteGroundedness', flagged: true },
        { check: 'clefRubric', flagged: true },
      ]);
    });

    it('passes through probability and reason from the guard', async () => {
      const [a] = drafts(1) as [Draft];
      const verdict: GuardVerdict = {
        check: 'graniteGroundedness',
        flagged: true,
        probability: 0.88,
        reason: 'claim not in source',
      };
      const guard: OutputGuard = {
        id: 'graniteGroundedness',
        checkDraft: () => Promise.resolve(verdict),
      };

      const out = await guardOutputStep([a], SOURCES, makeDeps([guard]));

      expect(out.rejected[0]?.verdicts).toEqual([verdict]);
    });
  });

  describe('logging', () => {
    function spyLogger() {
      const spies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const logger = { ...noopLogger, ...spies };
      const logged = (): string =>
        JSON.stringify(Object.values(spies).map((spy) => spy.mock.calls));
      return { logger, spies, logged };
    }

    it('logs the writer and flagging checks of a rejected draft', async () => {
      const [a] = drafts(1) as [Draft];
      const { logger, spies } = spyLogger();

      await guardOutputStep([a], SOURCES, {
        guards: [new FakeOutputGuard('clefRubric', flagging(a))],
        config: outputConfig({ checks: { graniteGroundedness: false } }),
        logger,
      });

      expect(spies.debug).toHaveBeenCalledWith(expect.any(String), {
        writer: a.writer,
        flaggedBy: ['clefRubric'],
      });
    });

    it('never logs digest or source text, whether a draft was rejected or a guard was missing', async () => {
      const [a, b] = drafts(2) as [Draft, Draft];
      const { logger, logged } = spyLogger();

      await guardOutputStep([a, b], SOURCES, {
        guards: [new FakeOutputGuard('clefRubric', flagging(a))],
        config: outputConfig(),
        logger,
      });

      const texts = [...SOURCES, ...a.digest.items].flatMap((entry) => [entry.title, entry.url]);
      for (const text of [...texts, a.digest.headline]) {
        expect(logged()).not.toContain(text);
      }
    });
  });

  describe('concurrency', () => {
    it('checks up to deps.concurrency drafts at once within a guard', async () => {
      const guard = new OverlapGuard('graniteGroundedness');
      const config = outputConfig({ checks: { clefRubric: false } });

      await guardOutputStep(drafts(5), SOURCES, { ...makeDeps([guard], config), concurrency: 3 });

      expect(guard.peak).toBe(3);
    });

    it('gives the same passed, rejected and verdicts at every limit', async () => {
      const list = drafts(6);
      const [a, b, c] = list as [Draft, Draft, Draft, ...Draft[]];
      const run = (concurrency: number) =>
        guardOutputStep(list, SOURCES, {
          ...makeDeps([
            new OverlapGuard('graniteGroundedness', flagging(a, c)),
            new OverlapGuard('clefRubric', flagging(b)),
          ]),
          concurrency,
        });

      const serial = await run(1);

      expect(await run(3)).toEqual(serial);
      expect(writers(serial.rejected.map((entry) => entry.draft))).toEqual([
        a.writer,
        b.writer,
        c.writer,
      ]);
    });

    it('rejects a limit that is not a whole number of at least 1, before any call', async () => {
      const granite = new FakeOutputGuard('graniteGroundedness');

      await expect(
        guardOutputStep(drafts(2), SOURCES, { ...makeDeps([granite]), concurrency: 1.5 }),
      ).rejects.toThrow(DigestError);

      expect(granite.calls).toEqual([]);
    });

    it('rejects with the error of a failing call at a higher limit and starts no later guard', async () => {
      const error = new Error('ollama unreachable');
      const granite = new ThrowingGuard('graniteGroundedness', error);
      const clef = new FakeOutputGuard('clefRubric');

      await expect(
        guardOutputStep(drafts(4), SOURCES, { ...makeDeps([granite, clef]), concurrency: 2 }),
      ).rejects.toBe(error);

      expect(granite.calls).toHaveLength(2);
      expect(clef.calls).toEqual([]);
    });
  });

  describe('errors and inputs', () => {
    it('rejects when a guard throws and does not start the next guard', async () => {
      const error = new Error('ollama unreachable');
      const granite = new ThrowingGuard('graniteGroundedness', error);
      const clef = new FakeOutputGuard('clefRubric');

      await expect(guardOutputStep(drafts(2), SOURCES, makeDeps([granite, clef]))).rejects.toBe(
        error,
      );

      expect(clef.calls).toEqual([]);
    });

    it('rejects when the second guard throws, instead of rejecting or passing silently', async () => {
      const error = new Error('model not installed');
      const granite = new FakeOutputGuard('graniteGroundedness');
      const clef = new ThrowingGuard('clefRubric', error);

      await expect(guardOutputStep(drafts(2), SOURCES, makeDeps([granite, clef]))).rejects.toBe(
        error,
      );
    });

    it('returns empty results for no drafts without calling a guard', async () => {
      const granite = new FakeOutputGuard('graniteGroundedness');
      const clef = new FakeOutputGuard('clefRubric');

      const out = await guardOutputStep([], SOURCES, makeDeps([granite, clef]));

      expect(out).toEqual<GuardOutputOutput>({ passed: [], rejected: [], disabledChecks: [] });
      expect(granite.calls).toEqual([]);
    });

    it('does not mutate frozen inputs while guards run', async () => {
      const [a, b, c] = drafts(3) as [Draft, Draft, Draft];
      const list: readonly Draft[] = Object.freeze([a, b, c]);
      const config = outputConfig({ mode: 'all' });
      Object.freeze(config.checks);
      Object.freeze(config);
      const granite = new FakeOutputGuard('graniteGroundedness', flagging(a, b));
      const clef = new FakeOutputGuard('clefRubric', flagging(b));

      const out = await guardOutputStep(
        list,
        Object.freeze([...SOURCES]),
        makeDeps(Object.freeze([granite, clef]), config),
      );

      expect(writers(out.passed)).toEqual([a.writer, c.writer]);
      expect(writers(out.rejected.map((entry) => entry.draft))).toEqual([b.writer]);
    });

    it('does not mutate its inputs and returns a new array when nothing runs', async () => {
      const list: readonly Draft[] = Object.freeze(drafts(2));
      const config = Object.freeze(outputConfig({ enabled: false }));

      const out = await guardOutputStep(list, SOURCES, makeDeps([], config));

      expect(out.passed).toEqual(list);
      expect(out.passed).not.toBe(list);
    });
  });
});
