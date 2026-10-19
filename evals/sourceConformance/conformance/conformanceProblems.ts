import type { Item } from '../../../src/domain/schemas';
import type { SourceGap } from '../../schema';

const COMPARED_FIELDS = [
  'id',
  'sourceId',
  'kind',
  'url',
  'title',
  'publishedAt',
  'summary',
] as const;

function fieldProblems(actual: Item, expected: Item, gaps: readonly SourceGap[]): string[] {
  return COMPARED_FIELDS.filter((field) => !(field === 'summary' && gaps.includes('summary')))
    .filter((field) => actual[field] !== expected[field])
    .map(
      (field) =>
        `${expected.url}: ${field} is ${JSON.stringify(actual[field])}, expected ${JSON.stringify(expected[field])}`,
    );
}

/** What differs between the items a fetcher yielded and the expected ones, by item id. */
export function conformanceProblems(
  actual: readonly Item[],
  expected: readonly Item[],
  knownGaps: readonly SourceGap[],
): string[] {
  const actualById = new Map(actual.map((item) => [item.id, item]));
  const expectedIds = new Set(expected.map((item) => item.id));
  const missing = expected
    .filter((item) => !actualById.has(item.id))
    .map((item) => `missing ${item.url}`);
  const unexpected = actual
    .filter((item) => !expectedIds.has(item.id))
    .map((item) => `unexpected ${item.url}`);
  const changed = expected.flatMap((item) => {
    const found = actualById.get(item.id);
    return found ? fieldProblems(found, item, knownGaps) : [];
  });
  return [...missing, ...unexpected, ...changed];
}
