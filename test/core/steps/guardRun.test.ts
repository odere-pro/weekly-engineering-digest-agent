// The guard engine both guard steps share (W5-06, F36): which guards run, and how they run.
import { describe, expect, it, vi } from 'vitest';
import {
  applyGuards,
  flaggedBy,
  planGuards,
  type GuardCheckFn,
} from '../../../src/core/steps/guardRun.js';
import type { GuardCheckId, GuardVerdict } from '../../../src/core/schemas.js';
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
