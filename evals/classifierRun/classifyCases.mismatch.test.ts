// classifyStep returns one result per item, so a different count is a bug in the step: the check
// in classifyCases is the guard against scoring labels against the wrong items. The step is
// replaced here to reach it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../../src/classify/classification';
import type * as classifyModule from '../../src/classify/classify';
import { classifyStep } from '../../src/classify/classify';
import { DigestError } from '../../src/shared/errors';
import { makeItem, makeScoredItem } from '../../test/builders';
import { makeApp } from '../evalKit';
import type { ClassifierCase } from '../schema';
import { classifyCases } from './classifyCases';

vi.mock('../../src/classify/classify', async (importOriginal) => ({
  ...(await importOriginal<typeof classifyModule>()),
  classifyStep: vi.fn(),
}));

const cases: ClassifierCase[] = [
  { item: makeItem({ title: 'C1' }), expected: { area: 'a', relevance: 2 } },
  { item: makeItem({ title: 'C2' }), expected: { area: 'b', relevance: 1 } },
];

describe('classifyCases when the classify step misbehaves', () => {
  beforeEach(() => {
    vi.mocked(classifyStep).mockReset();
  });

  it('throws a classify DigestError when the step returns fewer results than cases', async () => {
    vi.mocked(classifyStep).mockResolvedValue([makeScoredItem()]);

    const error = await classifyCases(makeApp().deps, cases).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toBe('classify returned 1 results for 2 cases');
    expect((error as DigestError).step).toBe('classify');
  });

  it('leaves out a case whose result has no classification', async () => {
    const withoutClassification = { ...makeScoredItem() } as Partial<ScoredItem>;
    delete withoutClassification.classification;
    vi.mocked(classifyStep).mockResolvedValue([
      makeScoredItem({}, { area: 'a', relevance: 2 }),
      withoutClassification as ScoredItem,
    ]);

    const results = await classifyCases(makeApp().deps, cases);

    expect(results).toEqual([
      { expected: cases[0]!.expected, actual: { area: 'a', relevance: 2 } },
    ]);
  });
});
