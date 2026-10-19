import { describe, expect, it } from 'vitest';
import { holdoutReport } from './holdoutReport';

describe('holdoutReport', () => {
  const off = { recall: 1, leaks: 1, withinOne: 0.5 };
  const on = { recall: 1.5, leaks: 0.5, withinOne: 0.75 };

  it('prints the table with the file off and on, then the keep verdict', () => {
    expect(holdoutReport(off, on, true)).toBe(
      [
        '                           off      on',
        'holdout recall (of 5)     1.00    1.50',
        'holdout leaks             1.00    0.50',
        'within-one accuracy      0.500   0.750',
        'verdict: keep',
        '',
      ].join('\n'),
    );
  });

  it('names the drop verdict and why', () => {
    expect(holdoutReport(off, on, false)).toContain(
      'verdict: drop (recall did not rise or leaks rose)\n',
    );
  });

  it('prints n/a where within-one accuracy is not measured', () => {
    const text = holdoutReport({ ...off, withinOne: null }, { ...on, withinOne: null }, true);

    expect(text).toContain('within-one accuracy        n/a     n/a');
  });
});
