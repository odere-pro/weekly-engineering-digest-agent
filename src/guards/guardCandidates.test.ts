import { describe, expect, it } from 'vitest';
import type { Item } from '../domain/schemas';
import { makeConfig, makeItem } from '../../test/builders';
import { FakeInputGuard, noopLogger } from '../../test/fakes';
import { DigestError } from '../shared/errors';
import type { InputGuard } from './Guard';
import {
  guardCandidatesStep,
  type GuardCandidatesDeps,
  type PickCandidates,
} from './guardCandidates';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';

const TOP_N = 5;

/** Ten items, best first, named a to j. */
const RANKED: readonly Item[] = 'abcdefghij'
  .split('')
  .map((letter) => makeItem({ id: letter, title: `Release ${letter}` }));

/** What `process` does here: the best `TOP_N` of the ranked items no guard flagged. */
function topOf(ranked: readonly Item[]): PickCandidates<Item> {
  return (flagged) => {
    const eligible = ranked.filter((item) => !flagged.has(item));
    return { picks: eligible.slice(0, TOP_N), next: eligible.slice(TOP_N) };
  };
}

const named =
  (...letters: string[]) =>
  (item: Item) =>
    letters.includes(item.id);
const idsOf = (list: readonly { id: string }[]): string[] => list.map((item) => item.id);

/** Records `${guardId}:${itemId}` in one log shared by the guards, to assert call order. */
class RecordingGuard implements InputGuard {
  constructor(
    readonly id: GuardCheckId,
    private readonly log: string[],
    private readonly flag: (item: Item) => boolean = () => false,
  ) {}

  checkItem(item: Item): Promise<GuardVerdict> {
    this.log.push(`${this.id}:${item.id}`);
    return Promise.resolve({ check: this.id, flagged: this.flag(item) });
  }
}

function deps(
  guards: readonly InputGuard[],
  mode: 'any' | 'all' = 'any',
  checks: Partial<GuardCandidatesDeps['config']['checks']> = {},
): GuardCandidatesDeps {
  const input = makeConfig().guards.input;
  return {
    guards,
    config: { ...input, mode, checks: { ...input.checks, ...checks } },
    logger: noopLogger,
  };
}

describe('guardCandidatesStep', () => {
  it('checks only the picks when no guard flags one', async () => {
    const clef = new FakeInputGuard('clefPolicy');
    const granite = new FakeInputGuard('graniteRisk');

    const result = await guardCandidatesStep(topOf(RANKED), deps([clef, granite]));

    expect(idsOf(result.kept)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(idsOf(clef.calls)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(idsOf(granite.calls)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result).toMatchObject({ dropped: [], checked: 5, rounds: 1 });
  });

  it('runs one guard over the whole batch before the next guard starts', async () => {
    const log: string[] = [];
    const guards = [new RecordingGuard('clefPolicy', log), new RecordingGuard('graniteRisk', log)];

    await guardCandidatesStep(topOf(RANKED.slice(0, 3)), deps(guards));

    expect(log).toEqual([
      'clefPolicy:a',
      'clefPolicy:b',
      'clefPolicy:c',
      'graniteRisk:a',
      'graniteRisk:b',
      'graniteRisk:c',
    ]);
  });

  it('replaces a flagged pick with the next item, checking a full batch ahead of need', async () => {
    const clef = new FakeInputGuard('clefPolicy', named('b'));
    const granite = new FakeInputGuard('graniteRisk');

    const result = await guardCandidatesStep(topOf(RANKED), deps([clef, granite]));

    expect(idsOf(result.kept)).toEqual(['a', 'c', 'd', 'e', 'f']);
    expect(idsOf(clef.calls)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(idsOf(result.dropped.map((entry) => entry.item))).toEqual(['b']);
    expect(result.dropped[0]?.verdicts).toEqual([{ check: 'clefPolicy', flagged: true }]);
    expect(result).toMatchObject({ checked: 10, rounds: 2 });
  });

  it('needs no round for an item an earlier batch already cleared', async () => {
    const clef = new FakeInputGuard('clefPolicy', named('b', 'c'));
    const granite = new FakeInputGuard('graniteRisk', named('f'));

    const result = await guardCandidatesStep(topOf(RANKED), deps([clef, granite]));

    expect(idsOf(result.kept)).toEqual(['a', 'd', 'e', 'g', 'h']);
    expect(idsOf(result.dropped.map((entry) => entry.item))).toEqual(['b', 'c', 'f']);
    expect(result).toMatchObject({ checked: 10, rounds: 2 });
  });

  it('keeps fewer than top N when the eligible items run out', async () => {
    const clef = new FakeInputGuard('clefPolicy', named('a', 'b'));

    const result = await guardCandidatesStep(topOf(RANKED.slice(0, 4)), deps([clef]));

    expect(idsOf(result.kept)).toEqual(['c', 'd']);
    expect(result.checked).toBe(4);
  });

  it('drops an item in mode all only when every model guard flags it', async () => {
    const clef = new FakeInputGuard('clefPolicy', named('a', 'b'));
    const granite = new FakeInputGuard('graniteRisk', named('b'));

    const result = await guardCandidatesStep(topOf(RANKED), deps([clef, granite], 'all'));

    expect(idsOf(result.kept)).toEqual(['a', 'c', 'd', 'e', 'f']);
    expect(idsOf(result.dropped.map((entry) => entry.item))).toEqual(['b']);
  });

  it('leaves the rule guard to the guardInput step', async () => {
    const rule = new FakeInputGuard('ruleInjection', () => true);
    const clef = new FakeInputGuard('clefPolicy');

    const result = await guardCandidatesStep(topOf(RANKED), deps([rule, clef]));

    expect(rule.calls).toEqual([]);
    expect(idsOf(result.kept)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns the picks unchecked when no model guard is on', async () => {
    const clef = new FakeInputGuard('clefPolicy', () => true);

    const result = await guardCandidatesStep(
      topOf(RANKED),
      deps([clef], 'any', { clefPolicy: false, graniteRisk: false }),
    );

    expect(clef.calls).toEqual([]);
    expect(idsOf(result.kept)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result).toMatchObject({ checked: 0, rounds: 0 });
  });

  it('tops up a batch in mode all, and drops only what every model guard flags', async () => {
    const clef = new FakeInputGuard('clefPolicy', named('a', 'b', 'f'));
    const granite = new FakeInputGuard('graniteRisk', named('b', 'f'));

    const result = await guardCandidatesStep(topOf(RANKED), deps([clef, granite], 'all'));

    expect(idsOf(result.kept)).toEqual(['a', 'c', 'd', 'e', 'g']);
    expect(idsOf(result.dropped.map((entry) => entry.item))).toEqual(['b', 'f']);
    expect(idsOf(clef.calls)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(result).toMatchObject({ checked: 10, rounds: 2 });
  });

  it('fails instead of looping when pick hands back copies of the items it was given', async () => {
    const copying: typeof topOf = (ranked) => (flagged) => {
      const picks = topOf(ranked)(flagged);
      return { picks: picks.picks.map((item) => ({ ...item })), next: [] };
    };
    const clef = new FakeInputGuard('clefPolicy');

    const pending = guardCandidatesStep(copying(RANKED), deps([clef]));

    await expect(pending).rejects.toThrow(DigestError);
    await expect(pending).rejects.toThrow(/items it was not given/);
  });

  it('stops between batches once the run is aborted', async () => {
    const controller = new AbortController();
    const clef = new FakeInputGuard('clefPolicy', named('a'));
    // The last call of the first batch fires the abort; that batch still finishes.
    const granite: InputGuard = {
      id: 'graniteRisk',
      checkItem: (item) => {
        if (item.id === 'e')
          controller.abort(new Error('Run aborted during the guardCandidates step'));
        return Promise.resolve({ check: 'graniteRisk', flagged: false });
      },
    };

    await expect(
      guardCandidatesStep(topOf(RANKED), { ...deps([clef, granite]), signal: controller.signal }),
    ).rejects.toThrow('Run aborted during the guardCandidates step');
    expect(idsOf(clef.calls)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves the warning about a missing guard to guardInput, which planned the guards first', async () => {
    const warnings: string[] = [];
    const logger = { ...noopLogger, warn: (message: string) => void warnings.push(message) };

    await guardCandidatesStep(topOf(RANKED), {
      ...deps([new FakeInputGuard('clefPolicy')]),
      logger,
    });

    expect(warnings).toEqual([]);
  });

  it('fails when a guard fails: a guard error is never a pass', async () => {
    const broken: InputGuard = {
      id: 'clefPolicy',
      checkItem: () => Promise.reject(new Error('clef answered nothing')),
    };

    await expect(guardCandidatesStep(topOf(RANKED), deps([broken]))).rejects.toThrow(
      'clef answered nothing',
    );
  });

  it('stops before the next call once the run is aborted', async () => {
    const controller = new AbortController();
    const clef: InputGuard = {
      id: 'clefPolicy',
      checkItem: () => {
        controller.abort(new Error('Run aborted during the guardCandidates step'));
        return Promise.resolve({ check: 'clefPolicy', flagged: false });
      },
    };

    await expect(
      guardCandidatesStep(topOf(RANKED), { ...deps([clef]), signal: controller.signal }),
    ).rejects.toThrow('Run aborted during the guardCandidates step');
  });
});
