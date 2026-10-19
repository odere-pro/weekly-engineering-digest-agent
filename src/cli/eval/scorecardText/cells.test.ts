// The table cells and the aligned table that the scorecard text and the compare text share.
import { describe, expect, it } from 'vitest';
import type { MetricResult } from '../../../../evals/schema';
import { gateCell, resultCell, table, valueCell } from './cells';

function metric(overrides: Partial<MetricResult> = {}): MetricResult {
  return {
    id: 'linkValidity',
    label: 'Link validity',
    unit: 'ratio',
    value: 1,
    gate: { kind: 'hard', direction: 'atLeast', threshold: 1, needsJudge: false },
    pass: true,
    ...overrides,
  };
}

describe('valueCell', () => {
  it('says n/a when the metric was not measured', () => {
    expect(valueCell(metric({ value: null }))).toBe('n/a');
  });

  it.each([
    ['ratio', 0.9, '90.0%'],
    ['ratio', 0.0625, '6.3%'],
    ['ms', 6172.5, '6.2 s'],
    ['count', 3.5, '3.50'],
    ['score', 4, '4.00'],
  ] as const)('prints a %s of %s as %s', (unit, value, printed) => {
    expect(valueCell(metric({ unit, value }))).toBe(printed);
  });
});

describe('gateCell', () => {
  it('says "reported" when the metric has no gate', () => {
    expect(gateCell(metric({ gate: { kind: 'none' } }))).toBe('reported');
  });

  it('prints a ratio threshold as a whole percent, with the kind and direction', () => {
    const gate = {
      kind: 'hard',
      direction: 'atLeast',
      threshold: 0.95,
      needsJudge: false,
    } as const;
    expect(gateCell(metric({ gate }))).toBe('hard ≥ 95%');
  });

  it('prints an at-most gate with ≤', () => {
    const gate = { kind: 'soft', direction: 'atMost', threshold: 0.05, needsJudge: false } as const;
    expect(gateCell(metric({ gate }))).toBe('soft ≤ 5%');
  });

  it('prints a threshold of another unit as it is', () => {
    const gate = { kind: 'soft', direction: 'atLeast', threshold: 3.5, needsJudge: false } as const;
    expect(gateCell(metric({ unit: 'score', gate }))).toBe('soft ≥ 3.5');
  });

  it('marks a gate that needs the judge', () => {
    const gate = { kind: 'soft', direction: 'atLeast', threshold: 3.5, needsJudge: true } as const;
    expect(gateCell(metric({ unit: 'score', gate }))).toBe('soft ≥ 3.5 (judge)');
  });
});

describe('resultCell', () => {
  it.each([
    [true, 'PASS'],
    [false, 'FAIL'],
    [null, '-'],
  ] as const)('prints pass=%s as %s', (pass, printed) => {
    expect(resultCell(metric({ pass }))).toBe(printed);
  });
});

describe('table', () => {
  it('pads each column to its widest cell, two spaces apart', () => {
    expect(
      table([
        ['Metric', 'Value'],
        ['Link validity', '100.0%'],
        ['Run time', '6.2 s'],
      ]),
    ).toEqual(['Metric         Value', 'Link validity  100.0%', 'Run time       6.2 s']);
  });

  it('trims the padding at the end of a line', () => {
    const [header, row] = table([
      ['A', 'B'],
      ['long cell', ''],
    ]);
    expect(header).toBe('A          B');
    expect(row).toBe('long cell');
  });

  it('returns no line for no rows', () => {
    expect(table([])).toEqual([]);
  });
});
