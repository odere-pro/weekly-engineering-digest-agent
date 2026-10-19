import { describe, expect, it } from 'vitest';
import {
  MAX_PROBLEMS_PER_WEEK,
  MAX_PROBLEM_CHARS,
  noDigest,
  uniqueLabels,
  weekDetail,
} from './weekDetail';

describe('weekDetail', () => {
  it('is ok with no problems when the check passed', () => {
    expect(weekDetail({ ok: true, problems: [] })).toEqual({
      status: 'ok',
      problems: [],
      problemCount: 0,
    });
  });

  it('keeps the first few problems and counts all of them', () => {
    const problems = Array.from({ length: MAX_PROBLEMS_PER_WEEK + 3 }, (_, i) => `problem ${i}`);

    const detail = weekDetail({ ok: false, problems });

    expect(detail.status).toBe('failed');
    expect(detail.problems).toEqual(problems.slice(0, MAX_PROBLEMS_PER_WEEK));
    expect(detail.problemCount).toBe(problems.length);
  });

  it('cuts a long problem message', () => {
    const detail = weekDetail({ ok: false, problems: ['x'.repeat(MAX_PROBLEM_CHARS * 2)] });

    expect(detail.problems[0]?.length).toBeLessThanOrEqual(MAX_PROBLEM_CHARS);
  });
});

describe('noDigest', () => {
  it('has no problems when the cause is unknown', () => {
    expect(noDigest()).toEqual({ status: 'no-digest', problems: [], problemCount: 0 });
  });

  it('keeps the cause as the one problem, cut short', () => {
    expect(noDigest('blocked by clefRubric')).toEqual({
      status: 'no-digest',
      problems: ['blocked by clefRubric'],
      problemCount: 1,
    });
    expect(noDigest('y'.repeat(MAX_PROBLEM_CHARS * 2)).problems[0]?.length).toBeLessThanOrEqual(
      MAX_PROBLEM_CHARS,
    );
  });
});

describe('uniqueLabels', () => {
  it('leaves distinct labels alone', () => {
    expect(uniqueLabels(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('numbers a repeat from the second occurrence on', () => {
    expect(uniqueLabels(['w', 'x', 'w', 'w'])).toEqual(['w', 'x', 'w (2)', 'w (3)']);
  });
});
