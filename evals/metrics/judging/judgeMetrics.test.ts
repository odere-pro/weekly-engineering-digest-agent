import { describe, expect, it } from 'vitest';
import {
  JUDGE_AGREEMENT_MIN,
  judgeAgreement,
  selectionAgreement,
  writingQuality,
} from './judgeMetrics';

describe('writingQuality', () => {
  it('is the mean score of the selected drafts', () => {
    expect(writingQuality([4, 3, 5]).value).toBe(4);
  });

  it('is null without scores', () => {
    expect(writingQuality([]).value).toBeNull();
  });
});

describe('selectionAgreement', () => {
  it('is the share of weeks where the judge picked the maintainer pick', () => {
    expect(
      selectionAgreement([
        { judge: 'a', human: 'a' },
        { judge: 'a', human: 'b' },
        { judge: 'b', human: 'b' },
        { judge: 'b', human: 'b' },
      ]).value,
    ).toBe(0.75);
  });

  it('is null without weeks', () => {
    expect(selectionAgreement([]).value).toBeNull();
  });
});

describe('judgeAgreement', () => {
  it('counts judge scores within half a point of the maintainer grade', () => {
    expect(
      judgeAgreement([
        { judge: 4.2, human: 4 },
        { judge: 3.4, human: 4 },
        { judge: 2.6, human: 3 },
        { judge: 5, human: 3 },
      ]).value,
    ).toBe(0.5);
  });

  it('counts a distance of exactly half a point as agreement, and a little more as a miss', () => {
    expect(judgeAgreement([{ judge: 4.5, human: 4 }]).value).toBe(1);
    expect(judgeAgreement([{ judge: 4.51, human: 4 }]).value).toBe(0);
  });

  it('is null without graded digests', () => {
    expect(judgeAgreement([]).value).toBeNull();
  });
});

describe('JUDGE_AGREEMENT_MIN', () => {
  it('is the 80% below which the judge is reported but not gated', () => {
    expect(JUDGE_AGREEMENT_MIN).toBe(0.8);
  });
});
