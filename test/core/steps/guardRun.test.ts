// The guard engine both guard steps share (W5-06, F36): which guards run, and how they run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGuards,
  flaggedBy,
  GUARD_CONCURRENCY,
  planGuards,
  type GuardCheckFn,
} from '../../../src/core/steps/guardRun.js';
import type { GuardCheckId, GuardVerdict } from '../../../src/core/schemas.js';
import { DigestError } from '../../../src/shared/errors.js';
import { noopLogger } from '../../fakes/index.js';

type Subject = string;

const verdict = (check: GuardCheckId, flagged: boolean): GuardVerdict => ({ check, flagged });

/** A check that flags the subjects in `flagged`, and logs each call to `log`. */
function check(
  id: GuardCheckId,
  flagged: readonly Subject[],
  log: string[] = [],
): GuardCheckFn<Subject> {
  return (subject) => {
    log.push(`${id}:${subject}`);
    return Promise.resolve(verdict(id, flagged.includes(subject)));
  };
}

describe('planGuards', () => {
  const switches = {
    enabled: true,
    checks: { clefPolicy: true, graniteRisk: true },
  };
  const guards = [{ id: 'graniteRisk' as const }, { id: 'clefPolicy' as const }];

  it('runs the guards in config order, whatever order they were supplied in', () => {
    const plan = planGuards(switches, guards, noopLogger);

    expect(plan.active.map((guard) => guard.id)).toEqual(['clefPolicy', 'graniteRisk']);
    expect(plan.disabledChecks).toEqual([]);
  });

  it('reports every check as disabled when the section is off, without a warning', () => {
    const warn = vi.fn();

    const plan = planGuards({ ...switches, enabled: false }, guards, { ...noopLogger, warn });

    expect(plan.active).toEqual([]);
    expect(plan.disabledChecks).toEqual(['clefPolicy', 'graniteRisk']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a check that config switched off, without a warning', () => {
    const warn = vi.fn();
    const config = { enabled: true, checks: { clefPolicy: false, graniteRisk: true } };

    const plan = planGuards(config, guards, { ...noopLogger, warn });

    expect(plan.active.map((guard) => guard.id)).toEqual(['graniteRisk']);
    expect(plan.disabledChecks).toEqual(['clefPolicy']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports an enabled check with no guard as disabled and warns, naming the check only', () => {
    const warn = vi.fn();

    const plan = planGuards(switches, [{ id: 'clefPolicy' as const }], { ...noopLogger, warn });

    expect(plan.disabledChecks).toEqual(['graniteRisk']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('graniteRisk'), {
      check: 'graniteRisk',
    });
  });
});

describe('applyGuards', () => {
  it('keeps every subject, in a new array, when there are no checks', async () => {
    const subjects = ['a', 'b'];

    const split = await applyGuards(subjects, [], 'any');

    expect(split).toEqual({ kept: ['a', 'b'], dropped: [] });
    expect(split.kept).not.toBe(subjects);
  });

  it('mode any drops a subject at once and shows the next guard only the unflagged ones', async () => {
    const log: string[] = [];

    const split = await applyGuards(
      ['a', 'b', 'c'],
      [check('clefPolicy', ['b'], log), check('graniteRisk', ['c'], log)],
      'any',
    );

    expect(split.kept).toEqual(['a']);
    expect(split.dropped).toEqual([
      { subject: 'b', verdicts: [verdict('clefPolicy', true)] },
      { subject: 'c', verdicts: [verdict('clefPolicy', false), verdict('graniteRisk', true)] },
    ]);
    expect(log).toEqual([
      'clefPolicy:a',
      'clefPolicy:b',
      'clefPolicy:c',
      'graniteRisk:a',
      'graniteRisk:c',
    ]);
  });

  it('mode all drops only what every guard flags, passing flagged subjects on', async () => {
    const log: string[] = [];

    const split = await applyGuards(
      ['a', 'b', 'c'],
      [check('clefPolicy', ['a', 'b'], log), check('graniteRisk', ['b'], log)],
      'all',
    );

    expect(split.kept).toEqual(['a', 'c']);
    expect(split.dropped.map((entry) => entry.subject)).toEqual(['b']);
    expect(log).toEqual([
      'clefPolicy:a',
      'clefPolicy:b',
      'clefPolicy:c',
      'graniteRisk:a',
      'graniteRisk:b',
    ]);
  });

  it('lists both groups in input order', async () => {
    const split = await applyGuards(
      ['a', 'b', 'c', 'd'],
      [check('clefPolicy', ['d']), check('graniteRisk', ['a'])],
      'any',
    );

    expect(split.kept).toEqual(['b', 'c']);
    expect(split.dropped.map((entry) => entry.subject)).toEqual(['a', 'd']);
  });

  it('lets a guard error through without starting the next guard', async () => {
    const next = vi.fn(check('graniteRisk', []));
    const failing: GuardCheckFn<Subject> = () => Promise.reject(new Error('guard model down'));

    await expect(applyGuards(['a'], [failing, next], 'any')).rejects.toThrow('guard model down');
    expect(next).not.toHaveBeenCalled();
  });
});

interface ProbeSpec {
  /** Fake milliseconds a call takes, by subject; the default is CALL_MS. */
  delays?: Readonly<Record<Subject, number>>;
  flagged?: readonly Subject[];
  /** Subjects whose call rejects, with the error it rejects with. */
  failing?: Readonly<Record<Subject, Error>>;
}

const CALL_MS = 10;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A check that takes fake time per call and watches itself: `events` gets `${id}:start:${subject}`
 * and `${id}:end:${subject}` (pass one array to several probes to see them interleave), and
 * `peak()` is the most calls that were ever in flight at once. Each verdict carries its subject
 * as the reason, so a test can tell a verdict was matched to the right subject.
 */
function probe(id: GuardCheckId, spec: ProbeSpec = {}, events: string[] = []) {
  let inFlight = 0;
  let peak = 0;
  const check: GuardCheckFn<Subject> = async (subject) => {
    events.push(`${id}:start:${subject}`);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(spec.delays?.[subject] ?? CALL_MS);
    inFlight -= 1;
    events.push(`${id}:end:${subject}`);
    const error = spec.failing?.[subject];
    if (error) throw error;
    return { check: id, flagged: spec.flagged?.includes(subject) ?? false, reason: subject };
  };
  return { check, events, peak: (): number => peak };
}

const startedBy = (events: readonly string[]): string[] =>
  events.filter((event) => event.includes(':start:')).map((event) => event.split(':')[2] ?? '');

/** Lets all fake time pass while `promise` runs, and gives back what it gave. */
async function drain<Result>(promise: Promise<Result>): Promise<Result> {
  const [result] = await Promise.all([promise, vi.runAllTimersAsync()]);
  return result;
}

describe('applyGuards with bounded concurrency', () => {
  const subjects: readonly Subject[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the limit', () => {
    it('is a named constant that is a positive whole number', () => {
      expect(Number.isInteger(GUARD_CONCURRENCY)).toBe(true);
      expect(GUARD_CONCURRENCY).toBeGreaterThanOrEqual(1);
    });

    it('is what a call without a limit uses', async () => {
      const guard = probe('clefPolicy');

      await drain(applyGuards(subjects, [guard.check], 'any'));

      expect(guard.peak()).toBe(Math.min(GUARD_CONCURRENCY, subjects.length));
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects %s before any call is made',
      async (limit) => {
        const guard = probe('clefPolicy');

        await expect(drain(applyGuards(subjects, [guard.check], 'any', limit))).rejects.toThrow(
          DigestError,
        );

        expect(guard.events).toEqual([]);
      },
    );

    it('rejects a bad limit even when there is nothing to check', async () => {
      await expect(applyGuards([], [], 'any', 0)).rejects.toThrow(/concurrency/);
    });
  });

  describe('at limit 1', () => {
    it('makes the same calls in the same order, one finishing before the next starts', async () => {
      const guard = probe('clefPolicy');

      await drain(applyGuards(['a', 'b', 'c'], [guard.check], 'any', 1));

      expect(guard.events).toEqual([
        'clefPolicy:start:a',
        'clefPolicy:end:a',
        'clefPolicy:start:b',
        'clefPolicy:end:b',
        'clefPolicy:start:c',
        'clefPolicy:end:c',
      ]);
      expect(guard.peak()).toBe(1);
    });
  });

  describe('at limit N', () => {
    it.each([2, 3, 5])(
      'has exactly %s calls in flight at the busiest and never more',
      async (limit) => {
        const guard = probe('clefPolicy');

        await drain(applyGuards(subjects, [guard.check], 'any', limit));

        expect(guard.peak()).toBe(limit);
      },
    );

    it('starts no more calls at once than there are subjects', async () => {
      const guard = probe('clefPolicy');

      await drain(applyGuards(['a', 'b'], [guard.check], 'any', 5));

      expect(guard.peak()).toBe(2);
    });

    it('starts the next call the moment a slot frees, not when the whole batch is done', async () => {
      const guard = probe('clefPolicy', { delays: { a: 100, b: 10, c: 10, d: 10 } });
      const run = applyGuards(['a', 'b', 'c', 'd'], [guard.check], 'any', 2);

      await vi.advanceTimersByTimeAsync(0);
      expect(startedBy(guard.events)).toEqual(['a', 'b']);

      await vi.advanceTimersByTimeAsync(10);
      expect(startedBy(guard.events)).toEqual(['a', 'b', 'c']);

      await vi.advanceTimersByTimeAsync(10);
      expect(startedBy(guard.events)).toEqual(['a', 'b', 'c', 'd']);
      expect(guard.events).not.toContain('clefPolicy:end:a');

      await drain(run);
    });

    it('keeps both lists in input order when calls finish in another order', async () => {
      const guard = probe('clefPolicy', {
        delays: { a: 50, b: 10, c: 40, d: 5, e: 20 },
        flagged: ['b', 'd', 'e'],
      });

      const split = await drain(applyGuards(['a', 'b', 'c', 'd', 'e'], [guard.check], 'any', 3));

      expect(split.kept).toEqual(['a', 'c']);
      expect(split.dropped).toEqual([
        { subject: 'b', verdicts: [{ check: 'clefPolicy', flagged: true, reason: 'b' }] },
        { subject: 'd', verdicts: [{ check: 'clefPolicy', flagged: true, reason: 'd' }] },
        { subject: 'e', verdicts: [{ check: 'clefPolicy', flagged: true, reason: 'e' }] },
      ]);
    });

    it('keeps input order in mode all too, with each subject keeping its own verdicts', async () => {
      const first = probe('clefPolicy', {
        delays: { a: 30, b: 5, c: 15 },
        flagged: ['a', 'b', 'c'],
      });
      const second = probe('graniteRisk', { delays: { a: 5, b: 25, c: 10 }, flagged: ['a', 'c'] });

      const split = await drain(
        applyGuards(['a', 'b', 'c'], [first.check, second.check], 'all', 3),
      );

      expect(split.kept).toEqual(['b']);
      expect(split.dropped).toEqual([
        {
          subject: 'a',
          verdicts: [
            { check: 'clefPolicy', flagged: true, reason: 'a' },
            { check: 'graniteRisk', flagged: true, reason: 'a' },
          ],
        },
        {
          subject: 'c',
          verdicts: [
            { check: 'clefPolicy', flagged: true, reason: 'c' },
            { check: 'graniteRisk', flagged: true, reason: 'c' },
          ],
        },
      ]);
    });

    it('stays guard by guard: every call of one guard ends before the next guard starts', async () => {
      const events: string[] = [];
      const first = probe('clefPolicy', { flagged: ['b'] }, events);
      const second = probe('graniteRisk', {}, events);

      await drain(applyGuards(['a', 'b', 'c', 'd'], [first.check, second.check], 'any', 3));

      const lastOfFirst = events.findLastIndex((event) => event.startsWith('clefPolicy:end'));
      const firstOfSecond = events.findIndex((event) => event.startsWith('graniteRisk:start'));
      expect(lastOfFirst).toBeLessThan(firstOfSecond);
      expect(startedBy(events.filter((event) => event.startsWith('graniteRisk')))).toEqual([
        'a',
        'c',
        'd',
      ]);
    });

    it('does not mutate frozen inputs', async () => {
      const frozen: readonly Subject[] = Object.freeze([...subjects]);
      const guard = probe('clefPolicy', { flagged: ['c'] });

      const split = await drain(applyGuards(frozen, [guard.check], 'any', 3));

      expect(split.kept).toEqual(['a', 'b', 'd', 'e', 'f', 'g']);
      expect(frozen).toEqual(subjects);
    });
  });

  describe('when a call fails', () => {
    it('rejects with its error and starts no further call, once the calls in flight are done', async () => {
      const error = new Error('guard model down');
      const first = probe('clefPolicy', { delays: { a: 50, b: 10 }, failing: { b: error } });
      const second = probe('graniteRisk');
      let settled = false;
      const outcome = applyGuards(['a', 'b', 'c', 'd'], [first.check, second.check], 'any', 2)
        .finally(() => {
          settled = true;
        })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(40);
      expect(await outcome).toBe(error);
      expect(startedBy(first.events)).toEqual(['a', 'b']);
      expect(second.events).toEqual([]);
    });

    it('rejects with the error of the earliest item when several calls fail', async () => {
      const early = new Error('item a failed');
      const late = new Error('item b failed');
      const guard = probe('clefPolicy', {
        delays: { a: 30, b: 10 },
        failing: { a: early, b: late },
      });

      await expect(drain(applyGuards(['a', 'b', 'c'], [guard.check], 'any', 3))).rejects.toBe(
        early,
      );
    });

    it('at limit 1 stops after the failing call, as before', async () => {
      const error = new Error('ollama unreachable');
      const guard = probe('clefPolicy', { failing: { b: error } });

      await expect(drain(applyGuards(['a', 'b', 'c'], [guard.check], 'any', 1))).rejects.toBe(
        error,
      );

      expect(startedBy(guard.events)).toEqual(['a', 'b']);
    });

    it('rejects with the error of a check that throws before it returns a promise', async () => {
      const error = new Error('bad subject');
      const throwing: GuardCheckFn<Subject> = () => {
        throw error;
      };

      await expect(drain(applyGuards(['a', 'b'], [throwing], 'any', 2))).rejects.toBe(error);
    });
  });
});

describe('flaggedBy', () => {
  it('lists the checks that flagged, never the reasons', () => {
    const verdicts: GuardVerdict[] = [
      { check: 'clefPolicy', flagged: false },
      { check: 'graniteRisk', flagged: true, reason: 'IGNORE ALL PREVIOUS INSTRUCTIONS' },
    ];

    expect(flaggedBy(verdicts)).toEqual(['graniteRisk']);
  });
});

describe('where the engine lives', () => {
  it('is no longer exported by the input guard step', async () => {
    const inputStep = await import('../../../src/core/steps/guardInput.js');

    expect(Object.keys(inputStep)).toEqual(['guardInputStep']);
  });

  it('is no longer exported by the output guard step', async () => {
    const outputStep = await import('../../../src/core/steps/guardOutput.js');

    expect(Object.keys(outputStep)).toEqual(['guardOutputStep']);
  });
});
