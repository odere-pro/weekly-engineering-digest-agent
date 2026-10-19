import { describe, expect, it } from 'vitest';
import { duplicates } from './duplicates';
import { entriesOf, scored, story } from '../__fixtures__/processKit';
import type { ScoredItem } from '../../classify/classification';

/** Ids that `duplicates` flags, for items listed best first (the order `processStep` passes). */
function flagged(items: readonly ScoredItem[]): string[] {
  const entries = entriesOf(items);
  const isRepeat = duplicates(entries);
  return entries.filter(isRepeat).map((entry) => entry.item.id);
}

describe('duplicates: same id or same title', () => {
  it('flags the later of two entries that share an id', () => {
    const entries = entriesOf([
      scored('same', {}, { url: 'https://example.com/b' }),
      scored('same', {}, { url: 'https://example.com/a' }),
    ]);

    expect(entries.map(duplicates(entries))).toEqual([false, true]);
  });

  it('flags the later of two sources that share a normalized title', () => {
    const news = story('news', 'news', '  kubernetes   1.34 is OUT ');
    const blog = story('blog', 'blog', 'Kubernetes 1.34 is out!');

    expect(flagged([news, blog])).toEqual(['blog']);
  });

  it('keeps the first of each story, so the caller controls the winner by order', () => {
    expect(flagged([story('a', 's1', 'Big launch'), story('b', 's2', 'Big launch')])).toEqual([
      'b',
    ]);
    expect(flagged([story('b', 's2', 'Big launch'), story('a', 's1', 'Big launch')])).toEqual([
      'a',
    ]);
  });

  it('collapses a chain of three sources to the first', () => {
    const chain = [
      story('b', 's2', 'Big launch'),
      story('c', 's3', 'big launch'),
      story('a', 's1', 'Big launch'),
    ];

    expect(flagged(chain)).toEqual(['c', 'a']);
  });

  it('does not merge items with the same title from the same source', () => {
    const first = story('one', 'feed', 'Weekly update');
    const second = story('two', 'feed', 'Weekly update');

    expect(flagged([first, second])).toEqual([]);
  });

  it('never treats blank titles as duplicates', () => {
    expect(flagged([story('one', 'a', '   '), story('two', 'b', '')])).toEqual([]);
  });

  it('folds Unicode forms when comparing titles', () => {
    const wide = story('b', 's2', 'Ｋｕｂｅｒｎｅｔｅｓ １．３４ live');
    const plain = story('a', 's1', 'Kubernetes 1.34 live');

    expect(flagged([wide, plain])).toEqual(['a']);
  });

  it('keeps titles apart when they differ only in non-ASCII letters or in + and #', () => {
    const titles = ['Größe 2 released', 'Grüße 2 released', 'C++ 23 released', 'C# 23 released'];

    expect(flagged(titles.map((title, i) => story(`t${i}`, `s${i}`, title)))).toEqual([]);
  });
});

describe('duplicates: the same release in different sources', () => {
  it('flags a blog post that repeats a GitHub release of the same tag', () => {
    const release = story('gh', 'transformers-releases', 'transformers v5.20.0: Release v5.20.0');
    const blog = story('blog', 'huggingface-blog', 'Transformers 5.20.0 is out');

    expect(flagged([release, blog])).toEqual(['blog']);
  });

  it('flags the second of Muse Spark Open on two clouds (the smoke pair)', () => {
    const hub = story('hub', 'huggingface-blog', 'Muse Spark Open 1.0 is now on Hugging Face');
    const aws = story(
      'aws',
      'aws-whats-new',
      'Announcing Muse Spark Open v1.0 on Amazon SageMaker JumpStart',
    );

    expect(flagged([aws, hub])).toEqual(['hub']);
  });

  it('collapses three sources to the first', () => {
    const three = [
      story('b', 's2', 'Kubernetes v1.34: Of Wind & Will'),
      story('c', 's3', 'Introducing Kubernetes 1.34'),
      story('a', 's1', 'Kubernetes 1.34 is out'),
    ];

    expect(flagged(three)).toEqual(['c', 'a']);
  });

  it('does not merge two items of the same source', () => {
    const one = story('one', 'feed', 'Tool 3.1 is out');
    const two = story('two', 'feed', 'Tool 3.1 migration guide');

    expect(flagged([one, two])).toEqual([]);
  });

  it('does not merge on a shared name without a version token', () => {
    const hub = story('hub', 's1', 'Muse Spark Open lands on Hugging Face');
    const aws = story('aws', 's2', 'Muse Spark Open now available on Amazon SageMaker JumpStart');

    expect(flagged([hub, aws])).toEqual([]);
  });

  it('leaves the original smoke pair to the writer: no version in the cloud post', () => {
    const release = story('gh', 'transformers-releases', 'transformers v5.20.0: Release v5.20.0');
    const cloud = story(
      'aws',
      'aws-whats-new',
      'Muse Spark Open model now available on Amazon SageMaker JumpStart',
    );

    expect(flagged([release, cloud])).toEqual([]);
  });

  it.each([
    ['another version', 'Kubernetes 1.34 is out', 'Kubernetes 1.35 is out'],
    ['another product', 'Alpha 2.0 is out', 'Beta 2.0 is out'],
    ['a model variant', 'Claude 3.5 Sonnet', 'Claude 3.5 Haiku'],
    ['support in another library', 'Python 3.13 support in numpy', 'Python 3.13 support in pandas'],
  ])('does not merge %s that shares a prefix', (_name, first, second) => {
    expect(flagged([story('one', 's1', first), story('two', 's2', second)])).toEqual([]);
  });
});

describe('duplicates: purity', () => {
  it('does not modify the entries it is given', () => {
    const items = Object.freeze([
      Object.freeze(story('a', 's1', 'Tool 5.0 is out')),
      Object.freeze(story('b', 's2', 'Tool 5.0 ships')),
    ]);
    const snapshot = structuredClone(items);

    flagged(items);

    expect(items).toEqual(snapshot);
  });

  it('flags nothing for an entry it was not given', () => {
    const repeats = duplicates(entriesOf([scored('a')]));

    expect(repeats({ item: scored('a') })).toBe(false);
  });

  it('tells two entries with equal ids apart by identity, not by value', () => {
    const item = scored('same');
    const entries = [{ item }, { item }];

    expect(entries.map(duplicates(entries))).toEqual([false, true]);
  });

  it('flags nothing for an empty list', () => {
    expect(flagged([])).toEqual([]);
  });
});
