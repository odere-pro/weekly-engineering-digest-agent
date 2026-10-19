import { describe, expect, it } from 'vitest';
import { ATTACKS, CLEAN, CLEAN_DRAFTS, policy, rawCapture, repeat } from '../__fixtures__/records';
import { NO_SPLIT } from '../split';
import { summaryText } from './summary';
import { tuneThresholds } from './tune';

describe('summaryText', () => {
  const weeks = ['2026-W38', '2026-W39', '2026-W40'];
  const inputGuards = [
    ...weeks.flatMap((week) => repeat(20, () => ({ ...policy('clean', 0.01), from: week }))),
    ...ATTACKS,
  ];

  it('lists each threshold as in use, then proposed', () => {
    const text = summaryText(tuneThresholds(rawCapture(), NO_SPLIT));
    const lines = text.split('\n');
    expect(lines[0]).toBe('light: 5 classifier cases, 20 clean items, 5 attacks');
    expect(lines[1]).toBe('  threshold        baseline  proposed');
    expect(lines.slice(2, 6)).toEqual([
      '  minRelevance     1.5       1.5',
      '  maxHype          0.5       0.5',
      '  maxMinorRelease  0.5       0.5',
      '  guardFlag        0.5       0.55',
    ]);
  });

  it('prints the headline numbers to three decimals', () => {
    const text = summaryText(tuneThresholds(rawCapture(), NO_SPLIT));
    expect(text).toContain('classifier accuracy (area and relevance): 0.600');
    expect(text).toContain('filter accuracy: 1.000 -> 1.000');
    expect(text).toContain('clefPolicy false blocks 0.000, attacks caught 3/5');
    expect(text).toContain('granite false blocks 0.000, attacks caught 3/5');
    expect(text).toContain('clefRubric false blocks on clean drafts 0.000');
    expect(text).toContain('input false blocks in mode "any" 0.000');
    expect(text).toContain('failed model calls: 0');
  });

  it('prints n/a for numbers it could not measure', () => {
    const text = summaryText(
      tuneThresholds(rawCapture({ inputGuards: [], outputGuards: [] }), NO_SPLIT),
    );
    expect(text).toContain('clefPolicy false blocks n/a');
    expect(text).toContain('clefRubric false blocks on clean drafts n/a');
  });

  it('adds the train and holdout sides when the result has a split', () => {
    const text = summaryText(tuneThresholds(rawCapture({ inputGuards })));
    expect(text).toContain('picked on train: ');
    expect(text).toContain('held out:        ');
    expect(text).toContain('2026-W39, 2026-W40');
    expect(text).toMatch(/train\s+holdout\s+gap/);
  });

  it('leaves the split out of a result written before it existed', () => {
    const { split: _split, scores: _scores, ...old } = tuneThresholds(rawCapture());
    expect(summaryText(old)).not.toContain('held out');
  });

  it('says "no weeks" for a side without a recorded week', () => {
    const text = summaryText(
      tuneThresholds(
        rawCapture({ inputGuards: [...CLEAN, ...ATTACKS], outputGuards: CLEAN_DRAFTS }),
        {
          holdoutWeeks: [],
          caseStride: 3,
        },
      ),
    );
    expect(text).toContain('(no weeks)');
  });
});
