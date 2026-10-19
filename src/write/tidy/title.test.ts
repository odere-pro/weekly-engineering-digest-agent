import { describe, expect, it } from 'vitest';
import { collapseRestatedTag, comparableWords, tidyTitle, withoutTrailingDots } from './title';
import { makeDigestItem, makeItem } from '../../../test/builders';

describe('collapseRestatedTag', () => {
  it.each([
    ['transformers v5.20.0: Release v5.20.0', 'transformers v5.20.0'],
    ['transformers v5.20.0: v5.20.0', 'transformers v5.20.0'],
    ['kubernetes v1.34: Version 1.34', 'kubernetes v1.34'],
    ['foo 1.2.0-rc1: Release 1.2.0-rc1', 'foo 1.2.0-rc1'],
    ['Release v5.20.0: Release v5.20.0', 'Release v5.20.0'],
    ['tool v2.0.0: Released v2.0.0.', 'tool v2.0.0'],
    ['tool v2.0.0 (beta): Tag v2.0.0 beta', 'tool v2.0.0 (beta)'],
    ['tool: Release', 'tool'],
  ])('drops a tail that only restates the head: %s', (title, expected) => {
    expect(collapseRestatedTag(title)).toBe(expected);
  });

  it.each([
    'Kubernetes v1.34: Of Wind & Will',
    'foo v2.0.0: Release v2.0.1',
    'Runner 2.4 adds ephemeral GPU runners',
    'Node.js 22: Release notes',
    'transformers v5.20.0 adds Muse Spark Open',
  ])('leaves a title that says something new alone: %s', (title) => {
    expect(collapseRestatedTag(title)).toBe(title);
  });

  it.each([
    ['no colon', 'tool v1.2.0 Release v1.2.0'],
    ['a colon first, so no head', ': Release v1.2.0'],
    ['nothing after the colon', 'tool v1.2.0:'],
    ['only spaces after the colon', 'tool v1.2.0:   '],
    ['an empty title', ''],
  ])('leaves a title with %s', (_name, title) => {
    expect(collapseRestatedTag(title)).toBe(title);
  });

  it('only looks at the first colon', () => {
    const title = 'tool v1.0.0: Release v1.0.0: the big one';

    expect(collapseRestatedTag(title)).toBe(title);
  });

  it('stays fast on a hostile tail made of dots', () => {
    const started = performance.now();

    const title = collapseRestatedTag(`tool v1.0.0: ${'.'.repeat(80_000)}x`);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(title).toContain('tool v1.0.0');
  });
});

describe('comparableWords', () => {
  it.each([
    ['Release v1.2.0.', ['release', '1.2.0']],
    ['Foo (Bar), baz; qux:', ['foo', 'bar', 'baz', 'qux']],
    ['v2 vim', ['2', 'vim']],
    ['[v3.1] done...', ['3.1', 'done']],
    ['...', []],
    ['', []],
  ])('lists the lowercase words of %j without dots and version prefix', (text, expected) => {
    expect(comparableWords(text)).toEqual(expected);
  });
});

describe('withoutTrailingDots', () => {
  it.each([
    ['abc...', 'abc'],
    ['abc.', 'abc'],
    ['...', ''],
    ['a.b', 'a.b'],
    ['.a', '.a'],
    ['', ''],
  ])('cuts the dots off the end of %j', (word, expected) => {
    expect(withoutTrailingDots(word)).toBe(expected);
  });

  it('handles a run of dots in linear time', () => {
    const started = performance.now();

    const result = withoutTrailingDots(`a${'.'.repeat(200_000)}`);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result).toBe('a');
  });
});

describe('tidyTitle', () => {
  const item = makeDigestItem(makeItem({ title: 'x' }), { title: 'tool v1.2.0: Release v1.2.0' });

  it('collapses the title and keeps every other field', () => {
    const tidied = tidyTitle(item);

    expect(tidied).toEqual({ ...item, title: 'tool v1.2.0' });
  });

  it('returns a new item and leaves the one it was given as it was', () => {
    const snapshot = structuredClone(item);

    const tidied = tidyTitle(item);

    expect(tidied).not.toBe(item);
    expect(item).toEqual(snapshot);
  });
});
