import { describe, expect, it } from 'vitest';
import { judgePick, SCORE_TIE_EPSILON } from './judgePick';
import type { CompleteDigest } from './types';

const draft = (writer: string, judgeScore: number): CompleteDigest => ({
  id: `d-${writer}`,
  week: '2026-W01',
  writer,
  humanGrade: 3,
  judgeScore,
});

describe('judgePick', () => {
  it('is the writer with the highest judge score', () => {
    expect(judgePick([draft('a', 3), draft('b', 4), draft('c', 3.5)])).toBe('b');
  });

  it('does not depend on the order of the drafts', () => {
    expect(judgePick([draft('c', 3.5), draft('b', 4), draft('a', 3)])).toBe('b');
  });

  it('is the only draft when there is one', () => {
    expect(judgePick([draft('a', 2)])).toBe('a');
  });

  it('is empty when there is no draft', () => {
    expect(judgePick([])).toBe('');
  });

  it('is empty on a tie at the top, as the judge then shows no preference', () => {
    expect(judgePick([draft('a', 4), draft('b', 4), draft('c', 2)])).toBe('');
  });

  it('is not tied by a lower score, however close it is above the epsilon', () => {
    expect(judgePick([draft('a', 4), draft('b', 4 - 1e-6)])).toBe('a');
  });

  it('counts scores 1e-12 apart as a tie, as the select step does', () => {
    expect(judgePick([draft('a', 4), draft('b', 4 + 1e-12)])).toBe('');
    expect(judgePick([draft('a', 4 + 1e-12), draft('b', 4)])).toBe('');
  });

  it('counts scores less than the epsilon apart as a tie, whatever its value', () => {
    expect(judgePick([draft('a', 4), draft('b', 4 + SCORE_TIE_EPSILON / 10)])).toBe('');
    expect(judgePick([draft('a', 4 + SCORE_TIE_EPSILON / 10), draft('b', 4)])).toBe('');
  });
});
