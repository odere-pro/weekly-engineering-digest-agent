import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../src/shared/errors';
import { selections } from './selections';
import type { CompleteDigest } from './types';

const digest = (week: string, writer: string, judgeScore: number): CompleteDigest => ({
  id: `${week}-${writer}`,
  week,
  writer,
  humanGrade: 3,
  judgeScore,
});

describe('selections', () => {
  it('pairs the maintainer pick of a week with the draft the judge scored highest', () => {
    const digests = [digest('2026-W01', 'a', 4), digest('2026-W01', 'b', 3)];

    expect(selections(digests, [{ week: '2026-W01', better: 'b' }])).toEqual([
      { human: 'b', judge: 'a' },
    ]);
  });

  it('gives one entry per pick, in the order of the picks', () => {
    const digests = [
      digest('2026-W01', 'a', 4),
      digest('2026-W01', 'b', 3),
      digest('2026-W02', 'a', 2),
      digest('2026-W02', 'b', 5),
    ];

    const result = selections(digests, [
      { week: '2026-W02', better: 'b' },
      { week: '2026-W01', better: 'a' },
    ]);

    expect(result).toEqual([
      { human: 'b', judge: 'b' },
      { human: 'a', judge: 'a' },
    ]);
  });

  it('judges a week from the drafts of that week only', () => {
    const digests = [
      digest('2026-W01', 'a', 1),
      digest('2026-W01', 'b', 2),
      digest('2026-W02', 'a', 5),
    ];

    expect(selections(digests, [{ week: '2026-W01', better: 'b' }])).toEqual([
      { human: 'b', judge: 'b' },
    ]);
  });

  it('leaves out of the result a week the maintainer made no pick for', () => {
    const digests = [
      digest('2026-W01', 'a', 4),
      digest('2026-W01', 'b', 3),
      digest('2026-W02', 'a', 4),
      digest('2026-W02', 'b', 3),
    ];

    expect(selections(digests, [{ week: '2026-W01', better: 'a' }])).toHaveLength(1);
  });

  it('shows no judge pick when the two scores tie', () => {
    const digests = [digest('2026-W01', 'a', 4), digest('2026-W01', 'b', 4)];

    expect(selections(digests, [{ week: '2026-W01', better: 'a' }])).toEqual([
      { human: 'a', judge: '' },
    ]);
  });

  it('needs at least one pick, since selection agreement is about the picks', () => {
    const failure = () => selections([digest('2026-W01', 'a', 4)], []);

    expect(failure).toThrow(DigestError);
    expect(failure).toThrow(
      'The grading sheet needs at least one pick: selection agreement compares your pick ' +
        "between two drafts of a week with the judge's.",
    );
  });

  it('rejects a pick for a week with fewer than two writers, and says how many it has', () => {
    const failure = () =>
      selections([digest('2026-W01', 'a', 4)], [{ week: '2026-W01', better: 'a' }]);

    expect(failure).toThrow(DigestError);
    expect(failure).toThrow(
      'Cannot compare drafts of 2026-W01: the sheet needs digests from two different writers, it has 1.',
    );
  });

  it('counts writers, not digests: two digests by one writer are not a comparison', () => {
    const digests = [digest('2026-W01', 'a', 4), { ...digest('2026-W01', 'a', 3), id: 'again' }];

    expect(() => selections(digests, [{ week: '2026-W01', better: 'a' }])).toThrow(
      /two different writers, it has 1/,
    );
  });

  it('rejects a pick for a week with no digests at all', () => {
    expect(() =>
      selections([digest('2026-W01', 'a', 4)], [{ week: '2026-W09', better: 'a' }]),
    ).toThrow(/Cannot compare drafts of 2026-W09.*it has 0/);
  });

  it('rejects a pick for a writer that has no digest that week, and lists the writers', () => {
    const digests = [digest('2026-W01', 'a', 4), digest('2026-W01', 'b', 3)];

    expect(() => selections(digests, [{ week: '2026-W01', better: 'zed' }])).toThrow(
      'The pick for 2026-W01 names "zed", which has no digest that week (writers: a, b).',
    );
  });
});
