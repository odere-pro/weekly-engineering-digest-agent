import { describe, expect, it } from 'vitest';
import { makeConfig, makeItem } from '../../test/builders';
import { FakeInputGuard, noopLogger } from '../../test/fakes';
import type { GuardCheckId } from '../../src/guards/guardVerdict';
import type { InputVerdict } from './guardVerdicts';
import { sweepInputGuards } from './sweepInputGuards';

const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => makeItem({ id, title: `Release ${id}` })) as [
  ReturnType<typeof makeItem>,
  ReturnType<typeof makeItem>,
  ReturnType<typeof makeItem>,
  ReturnType<typeof makeItem>,
];
const INPUT = makeConfig().guards.input;

const verdict = (guardId: GuardCheckId, itemId: string, flagged = false): InputVerdict => ({
  guardId,
  itemId,
  verdict: { check: guardId, flagged },
});

/** What the run logged: the rule guard on a, b and c; the model guards on the one candidate a. */
const RUN: readonly InputVerdict[] = [
  verdict('ruleInjection', 'a'),
  verdict('ruleInjection', 'b'),
  verdict('ruleInjection', 'c'),
  verdict('clefPolicy', 'a'),
  verdict('graniteRisk', 'a'),
];

const ids = (list: readonly { id: string }[]): string[] => list.map((item) => item.id);
const keys = (list: readonly InputVerdict[]): string[] =>
  list.map(({ guardId, itemId }) => `${guardId}:${itemId}`);

describe('sweepInputGuards', () => {
  it('asks each guard only about the collected items the run did not show it', async () => {
    const rule = new FakeInputGuard('ruleInjection');
    const clef = new FakeInputGuard('clefPolicy');
    const granite = new FakeInputGuard('graniteRisk');

    const swept = await sweepInputGuards([rule, clef, granite], [a, b, c, d], RUN, {
      config: INPUT,
      logger: noopLogger,
    });

    expect(rule.calls).toEqual([]);
    expect(ids(clef.calls)).toEqual(['b', 'c']);
    expect(ids(granite.calls)).toEqual(['b', 'c']);
    expect(keys(swept)).toEqual([
      ...keys(RUN),
      'clefPolicy:b',
      'clefPolicy:c',
      'graniteRisk:b',
      'graniteRisk:c',
    ]);
  });

  it('shows a later guard only what the earlier ones let through, as the chain did before', async () => {
    const clef = new FakeInputGuard('clefPolicy', (item) => item.id === 'b');
    const granite = new FakeInputGuard('graniteRisk');

    await sweepInputGuards([new FakeInputGuard('ruleInjection'), clef, granite], [a, b, c], RUN, {
      config: INPUT,
      logger: noopLogger,
    });

    expect(ids(granite.calls)).toEqual(['c']);
  });

  it('leaves the run verdicts as they were', async () => {
    const run = [...RUN];

    await sweepInputGuards([new FakeInputGuard('clefPolicy')], [a, b], run, {
      config: INPUT,
      logger: noopLogger,
    });

    expect(run).toEqual(RUN);
  });
});
