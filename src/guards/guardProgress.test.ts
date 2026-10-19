// The guard steps log how far a guard is through its pool, so a slow model (clef took 15 s a call
// on a 32 GB laptop, 2026-10-19) is not an hour of silence.
import { describe, expect, it, vi } from 'vitest';
import type { Draft, Item } from '../domain/schemas';
import type { LogFields, Logger } from '../shared/telemetry';
import type { GuardCheckId } from './guardVerdict';
import { guardInputStep } from './guardInput';
import { guardOutputStep } from './guardOutput';
import { makeConfig, makeDraft, makeItem } from '../../test/builders';
import { FakeInputGuard, FakeOutputGuard, noopLogger } from '../../test/fakes';
import { steppedClock } from '../shared/__fixtures__/steppedClock';

interface Progress {
  label: unknown;
  done: unknown;
  total: unknown;
}

function recording(): { logger: Logger; progress: () => Progress[] } {
  const info = vi.fn<(message: string, fields?: LogFields) => void>();
  return {
    logger: { ...noopLogger, info },
    progress: () =>
      info.mock.calls
        .filter(([message]) => message === 'Progress')
        .map(([, fields]) => ({ label: fields?.label, done: fields?.done, total: fields?.total })),
  };
}

/** Takes `ms` of the stepped clock for each subject it checks, and flags the ones in `flagged`. */
function slowFlag<Subject extends { id?: string; writer?: string }>(
  advance: (ms: number) => void,
  ms: number,
  flagged: readonly Subject[] = [],
) {
  return (subject: Subject): boolean => {
    advance(ms);
    return flagged.includes(subject);
  };
}

const items = (count: number): Item[] => Array.from({ length: count }, () => makeItem());
const modelChecks = (): ReturnType<typeof makeConfig>['guards']['input'] => {
  const { ruleInjection: _rule, ...rest } = makeConfig().guards.input.checks;
  const base = makeConfig().guards.input;
  return { ...base, checks: rest as typeof base.checks };
};

describe('guardInputStep progress', () => {
  it('logs each guard on its own pool, labelled with the guard id', async () => {
    const time = steppedClock();
    const { logger, progress } = recording();
    const guards = [
      new FakeInputGuard('clefPolicy', slowFlag(time.advance, 1_000)),
      new FakeInputGuard('graniteRisk', slowFlag(time.advance, 1_000)),
    ];

    await guardInputStep(items(30), {
      guards,
      config: modelChecks(),
      logger,
      clock: time.clock,
    });

    expect(progress()).toEqual([
      { label: 'clefPolicy', done: 25, total: 30 },
      { label: 'clefPolicy', done: 30, total: 30 },
      { label: 'graniteRisk', done: 25, total: 30 },
      { label: 'graniteRisk', done: 30, total: 30 },
    ]);
  });

  it('counts the second guard over what the first let through (mode any)', async () => {
    const time = steppedClock();
    const { logger, progress } = recording();
    const pool = items(30);
    const guards = [
      new FakeInputGuard('clefPolicy', slowFlag(time.advance, 1_000, pool.slice(0, 6))),
      new FakeInputGuard('graniteRisk', slowFlag(time.advance, 1_000)),
    ];

    await guardInputStep(pool, { guards, config: modelChecks(), logger, clock: time.clock });

    expect(progress().filter((line) => line.label === 'graniteRisk')).toEqual([
      { label: 'graniteRisk', done: 24, total: 24 },
    ]);
  });

  it('logs by the minute when a guard is slow, before 25 items are done', async () => {
    const time = steppedClock();
    const { logger, progress } = recording();
    const guards = [new FakeInputGuard('clefPolicy', slowFlag(time.advance, 15_000))];

    await guardInputStep(items(10), { guards, config: modelChecks(), logger, clock: time.clock });

    expect(progress().map((line) => line.done)).toEqual([4, 8, 10]);
  });

  it('says nothing about the rule guard, which makes no model call', async () => {
    const time = steppedClock();
    const { logger, progress } = recording();
    const rule = new FakeInputGuard('ruleInjection', slowFlag(time.advance, 1_000));
    const config = makeConfig().guards.input;
    const model = new FakeInputGuard('clefPolicy', slowFlag(time.advance, 1_000));

    await guardInputStep(items(30), {
      guards: [rule, model],
      config: { ...config, checks: { ...config.checks, graniteRisk: false } },
      logger,
      clock: time.clock,
    });

    expect(new Set(progress().map((line) => line.label))).toEqual(new Set(['clefPolicy']));
  });

  it('logs nothing for an empty pool', async () => {
    const { logger, progress } = recording();

    await guardInputStep([], {
      guards: [new FakeInputGuard('clefPolicy')],
      config: modelChecks(),
      logger,
    });

    expect(progress()).toEqual([]);
  });

  it('puts no item text or id in a progress line', async () => {
    const time = steppedClock();
    const info = vi.fn<(message: string, fields?: LogFields) => void>();
    const guards = [new FakeInputGuard('clefPolicy', slowFlag(time.advance, 1_000))];

    await guardInputStep(items(25), {
      guards,
      config: modelChecks(),
      logger: { ...noopLogger, info },
      clock: time.clock,
    });

    const [fields] = info.mock.calls
      .filter(([message]) => message === 'Progress')
      .map(([, f]) => f);
    expect(Object.keys(fields ?? {}).sort()).toEqual(
      ['done', 'elapsedMs', 'eta', 'etaMs', 'label', 'medianMs', 'total'].sort(),
    );
  });
});

describe('guardOutputStep progress', () => {
  it('logs each output guard over the drafts', async () => {
    const time = steppedClock();
    const { logger, progress } = recording();
    const sources: Item[] = [makeItem()];
    const drafts: Draft[] = [makeDraft(sources, 'writer-1'), makeDraft(sources, 'writer-2')];
    const config = makeConfig().guards.output;
    const checks = Object.fromEntries(
      Object.keys(config.checks).map((id) => [id, id === 'graniteGroundedness']),
    ) as typeof config.checks;
    const guard = new FakeOutputGuard(
      'graniteGroundedness' satisfies GuardCheckId,
      slowFlag(time.advance, 1_000),
    );

    await guardOutputStep(drafts, sources, {
      guards: [guard],
      config: { ...config, checks },
      logger,
      clock: time.clock,
    });

    expect(progress()).toEqual([{ label: 'graniteGroundedness', done: 2, total: 2 }]);
  });
});
