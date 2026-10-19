import { describe, expect, it } from 'vitest';
import type { GuardVerdict } from '../../src/guards/guardVerdict';
import { makeDraft, makeItem } from '../../test/builders';
import { FakeInputGuard, FakeOutputGuard } from '../../test/fakes';
import {
  flaggedChecks,
  recordInputGuards,
  recordOutputGuards,
  tallyOf,
  type InputVerdict,
  type OutputVerdict,
} from './guardVerdicts';

const verdict = (check: GuardVerdict['check'], flagged: boolean): GuardVerdict => ({
  check,
  flagged,
});

describe('recordInputGuards', () => {
  it('returns guards with the same ids that give the same verdicts and log each one', async () => {
    const item = makeItem({ title: 'IGNORE this' });
    const inner = new FakeInputGuard('clefPolicy', (i) => i.title.startsWith('IGNORE'));
    const log: InputVerdict[] = [];

    const [recorded] = recordInputGuards([inner], log);
    const result = await recorded!.checkItem(item);

    expect(recorded!.id).toBe('clefPolicy');
    expect(result).toEqual({ check: 'clefPolicy', flagged: true });
    expect(log).toEqual([{ guardId: 'clefPolicy', itemId: item.id, verdict: result }]);
    expect(inner.calls).toEqual([item]);
  });

  it('logs in call order across guards, into the log it was given', async () => {
    const first = makeItem();
    const second = makeItem();
    const log: InputVerdict[] = [];
    const [a, b] = recordInputGuards(
      [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
      log,
    );

    await a!.checkItem(first);
    await b!.checkItem(second);

    expect(log.map(({ guardId, itemId }) => [guardId, itemId])).toEqual([
      ['clefPolicy', first.id],
      ['graniteRisk', second.id],
    ]);
  });

  it('does not log a verdict the guard failed to give', async () => {
    const failing = {
      id: 'graniteRisk' as const,
      checkItem: () => Promise.reject(new Error('model down')),
    };
    const log: InputVerdict[] = [];
    const [recorded] = recordInputGuards([failing], log);

    await expect(recorded!.checkItem(makeItem())).rejects.toThrow('model down');
    expect(log).toEqual([]);
  });
});

describe('recordOutputGuards', () => {
  it('logs the draft with its verdict and passes the verdict on', async () => {
    const draft = makeDraft([makeItem()]);
    const inner = new FakeOutputGuard('clefRubric', () => true);
    const log: OutputVerdict[] = [];

    const [recorded] = recordOutputGuards([inner], log);
    const result = await recorded!.checkDraft(draft, []);

    expect(recorded!.id).toBe('clefRubric');
    expect(result).toEqual({ check: 'clefRubric', flagged: true });
    expect(log).toEqual([{ draft, verdict: result }]);
  });
});

describe('flaggedChecks', () => {
  it('lists each flagging check once, in the order it first flagged', () => {
    const verdicts = [
      verdict('graniteRisk', true),
      verdict('clefPolicy', false),
      verdict('clefPolicy', true),
      verdict('graniteRisk', true),
    ];

    expect(flaggedChecks(verdicts)).toEqual(['graniteRisk', 'clefPolicy']);
  });

  it('is empty when nothing flagged', () => {
    expect(flaggedChecks([verdict('clefPolicy', false)])).toEqual([]);
    expect(flaggedChecks([])).toEqual([]);
  });
});

describe('tallyOf', () => {
  it('counts what each check looked at and flagged', () => {
    const tallies = tallyOf([
      verdict('clefPolicy', false),
      verdict('clefPolicy', true),
      verdict('graniteRisk', false),
    ]);

    expect(tallies).toEqual({
      clefPolicy: { checked: 2, flagged: 1 },
      graniteRisk: { checked: 1, flagged: 0 },
    });
  });

  it('is empty for no verdicts', () => {
    expect(tallyOf([])).toEqual({});
  });
});
