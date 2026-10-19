import { describe, expect, it } from 'vitest';
import type { RescoreResult } from '../replay/types';
import { formatResult } from './formatResult';

describe('formatResult', () => {
  const result: RescoreResult = {
    rescoreWithWriter: true,
    weeks: 6,
    mustIncludeRecall: 1.5,
    mustExcludeLeaks: 0.25,
    classifierAccuracy: 0.3,
    secondsPerWeek: 12.34,
  };

  it('prints the three numbers and the time', () => {
    const text = formatResult('light', result);

    expect(text).toContain('rescoreWithWriter: on');
    expect(text).toContain('must-include recall: 1.50 of 5');
    expect(text).toContain('must-exclude leaks: 0.25');
    expect(text).toContain('classifier accuracy: 30.0%');
    expect(text).toContain('seconds per week: 12.3');
    expect(
      formatResult('light', { ...result, classifierAccuracy: null, mustIncludeRecall: null }),
    ).toContain('classifier accuracy: n/a');
  });

  it('prints the exact text, one line per number and a closing newline', () => {
    expect(formatResult('light', result)).toBe(
      [
        'profile: light  rescoreWithWriter: on  calibration: off  pairwise: off  weeks: 6',
        'must-include recall: 1.50 of 5',
        'must-exclude leaks: 0.25',
        'classifier accuracy: 30.0%',
        'seconds per week: 12.3',
        '',
      ].join('\n'),
    );
  });

  it('shows calibration and pairwise as on when the result has them', () => {
    const text = formatResult('fast', {
      ...result,
      rescoreWithWriter: false,
      calibrated: true,
      pairwise: true,
    });

    expect(text.split('\n')[0]).toBe(
      'profile: fast  rescoreWithWriter: off  calibration: on  pairwise: on  weeks: 6',
    );
  });

  it('prints n/a for every number that was not measured', () => {
    const text = formatResult('light', {
      rescoreWithWriter: false,
      weeks: 0,
      mustIncludeRecall: null,
      mustExcludeLeaks: null,
      classifierAccuracy: null,
      secondsPerWeek: null,
    });

    expect(text).toContain('must-include recall: n/a of 5');
    expect(text).toContain('must-exclude leaks: n/a');
    expect(text).toContain('classifier accuracy: n/a');
    expect(text).toContain('seconds per week: n/a');
  });
});
