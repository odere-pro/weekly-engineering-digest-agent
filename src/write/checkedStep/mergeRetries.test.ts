import { describe, expect, it } from 'vitest';
import type { Draft } from '../../domain/schemas';
import { mergeRetries } from './mergeRetries';
import type { CodeChecked } from './types';
import { makeDigest, makeItem } from '../../../test/builders';

function entry(writer: string, markdown: string, rejectedBy: readonly string[] = []): CodeChecked {
  const draft: Draft = { writer, digest: makeDigest([makeItem()]) };
  return { draft, markdown, rejectedBy, problems: [] };
}

describe('mergeRetries', () => {
  const firstA = entry('writer-a', 'first a', ['linkCheck']);
  const firstB = entry('writer-b', 'first b', ['formatCheck']);
  const firstC = entry('writer-c', 'first c', ['linkCheck']);

  it('puts each retry in the place of its writer first draft, in the first drafts order', () => {
    const retryA = entry('writer-a', 'retry a');
    const retryC = entry('writer-c', 'retry c');

    const merged = mergeRetries([firstA, firstB, firstC], [retryC, retryA]);

    expect(merged.checked).toEqual([retryA, firstB, retryC]);
    expect(merged.retried).toEqual([retryA, retryC]);
  });

  it('keeps the first draft of a writer whose retry produced no draft', () => {
    const retryB = entry('writer-b', 'retry b');

    const merged = mergeRetries([firstA, firstB], [retryB]);

    expect(merged.checked).toEqual([firstA, retryB]);
    expect(merged.retried).toEqual([retryB]);
  });

  it('returns the first drafts as they were when there are no retries', () => {
    const merged = mergeRetries([firstA, firstB], []);

    expect(merged.checked).toEqual([firstA, firstB]);
    expect(merged.retried).toEqual([]);
  });

  it('does not take a retry from a writer that had no first draft', () => {
    const stranger = entry('writer-z', 'retry z');

    const merged = mergeRetries([firstA], [stranger]);

    expect(merged.checked).toEqual([firstA]);
    expect(merged.retried).toEqual([]);
  });

  it('returns nothing for no first drafts', () => {
    expect(mergeRetries([], [])).toEqual({ checked: [], retried: [] });
  });

  it('does not change the lists it was given', () => {
    const first = [firstA, firstB];
    const retries = [entry('writer-a', 'retry a')];

    mergeRetries(first, retries);

    expect(first).toEqual([firstA, firstB]);
    expect(retries).toHaveLength(1);
  });
});
