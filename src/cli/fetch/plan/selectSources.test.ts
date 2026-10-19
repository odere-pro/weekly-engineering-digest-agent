import { describe, expect, it } from 'vitest';
import type { Source } from '../../../domain/schemas';
import { DigestError } from '../../../shared/errors';
import { selectSources } from './selectSources';

const source = (id: string): Source => ({ id, kind: 'rss', url: `https://example.com/${id}.xml` });
const ALL = [source('alpha'), source('beta'), source('gamma')];

describe('selectSources', () => {
  it.each([undefined, []])('takes every source when none are named (%j)', (wanted) => {
    expect(selectSources(ALL, wanted)).toEqual(ALL);
  });

  it('hands back a new list when it takes every source', () => {
    expect(selectSources(ALL, undefined)).not.toBe(ALL);
  });

  it('takes the named sources in config order, not in the order named', () => {
    expect(selectSources(ALL, ['gamma', 'alpha']).map((s) => s.id)).toEqual(['alpha', 'gamma']);
  });

  it('takes a source named twice once', () => {
    expect(selectSources(ALL, ['beta', 'beta']).map((s) => s.id)).toEqual(['beta']);
  });

  it('refuses an id the config does not have, and lists the ones it has', () => {
    const run = (): Source[] => selectSources(ALL, ['alpha', 'nope', 'also-nope', 'nope']);

    expect(run).toThrow(DigestError);
    expect(run).toThrow(
      'Unknown source: nope, also-nope. Sources in the config: alpha, beta, gamma',
    );
  });

  it('refuses any name when the config has no sources', () => {
    expect(() => selectSources([], ['alpha'])).toThrow(
      'Unknown source: alpha. Sources in the config: ',
    );
  });

  it('does not change the list it is given', () => {
    const all = Object.freeze([...ALL]);

    expect(selectSources(all, ['beta'])).toHaveLength(1);
    expect(all).toEqual(ALL);
  });
});
