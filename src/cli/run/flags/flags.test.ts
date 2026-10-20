import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { harness } from '../__fixtures__/runHarness';
import { parseOut, parseSeed, withOut, withSeed, withSources } from './flags';

describe('parseSeed', () => {
  it('passes a whole number of 0 or more and undefined through', () => {
    expect(parseSeed(undefined)).toBeUndefined();
    expect(parseSeed(0)).toBe(0);
    expect(parseSeed(7)).toBe(7);
  });

  it.each([-1, 1.5, Number.NaN])('rejects %s', (seed) => {
    expect(() => parseSeed(seed)).toThrow(DigestError);
    expect(() => parseSeed(seed)).toThrow(/Invalid --seed/);
  });
});

describe('withSeed', () => {
  it('returns a new config with models.seed set and leaves the input alone', () => {
    const { loaded } = harness();

    const next = withSeed(loaded, 7);

    expect(next.config.models.seed).toBe(7);
    expect(loaded.config.models.seed).toBe(42);
    expect(next.secrets).toBe(loaded.secrets);
  });

  it('returns the same object without a seed', () => {
    const { loaded } = harness();

    expect(withSeed(loaded, undefined)).toBe(loaded);
  });
});

describe('parseOut', () => {
  it('passes a folder as given and undefined through', () => {
    expect(parseOut(undefined)).toBeUndefined();
    expect(parseOut('./digests')).toBe('./digests');
  });

  it.each(['', '   '])('rejects the blank "%s"', (out) => {
    expect(() => parseOut(out)).toThrow(/Invalid --out/);
  });
});

describe('withOut', () => {
  it('returns a new config with the Markdown folder set and leaves the input alone', () => {
    const { loaded } = harness();

    const next = withOut(loaded, 'my/digests');

    expect(next.config.delivery.markdown.dir).toBe('my/digests');
    expect(loaded.config.delivery.markdown.dir).toBeUndefined();
    expect(next.config.models).toBe(loaded.config.models);
  });

  it('returns the same object without a folder', () => {
    const { loaded } = harness();

    expect(withOut(loaded, undefined)).toBe(loaded);
  });
});

describe('withSources', () => {
  const added = [{ id: 'new', kind: 'rss', url: 'https://new.example.com/feed' }] as const;

  it('returns a new config with the sources after the configured ones, input untouched', () => {
    const { loaded } = harness();

    const next = withSources(loaded, added);

    expect(next.config.sources.map((s) => s.id)).toEqual(['example-feed', 'new']);
    expect(loaded.config.sources).toHaveLength(1);
  });

  it('returns the same object without sources', () => {
    const { loaded } = harness();

    expect(withSources(loaded, [])).toBe(loaded);
  });
});
