import { describe, expect, it } from 'vitest';
import { perspectiveOf, topicSlug, variantLabel, variantSlug, type RunVariant } from './variant';

const SLUG_RULE = /^[a-z0-9][a-z0-9-]{0,59}$/;

describe('topicSlug', () => {
  it('lowercases, joins words with dashes and drops edge dashes', () => {
    expect(topicSlug('  Security & Supply-Chain!  ')).toBe('security-supply-chain');
  });

  it('cuts to 40 characters without a trailing dash', () => {
    const slug = topicSlug(`${'a'.repeat(39)} bbbbbb`);
    expect(slug).toBe('a'.repeat(39));
    expect(topicSlug('x'.repeat(80))).toHaveLength(40);
  });

  it.each(['', '   ', '!!!', 'ключ'])('falls back to "topic" for %j', (topic) => {
    expect(topicSlug(topic)).toBe('topic');
  });
});

describe('variantSlug and variantLabel', () => {
  const cases: [RunVariant, string, string][] = [
    [{ kind: 'enrich' }, 'enriched', 'enriched'],
    [{ kind: 'add-sources' }, 'enriched', 'enriched'],
    [{ kind: 'complete' }, 'complete', 'complete'],
    [{ kind: 'perspective', topic: 'Security' }, 'perspective-security', 'perspective: Security'],
  ];
  it.each(cases)('%j → %s / %s', (variant, slug, label) => {
    expect(variantSlug(variant)).toBe(slug);
    expect(variantLabel(variant)).toBe(label);
    expect(slug).toMatch(SLUG_RULE);
  });

  it('keeps a long or odd topic inside the slug rule and cuts the label to 40', () => {
    const variant: RunVariant = { kind: 'perspective', topic: 'Zero Trust '.repeat(10) };
    expect(variantSlug(variant)).toMatch(SLUG_RULE);
    expect(variantLabel(variant)).toBe(`perspective: ${variant.topic?.trim().slice(0, 40)}`);
  });

  it('gives a perspective without a topic the slug perspective-topic', () => {
    expect(variantSlug({ kind: 'perspective' })).toBe('perspective-topic');
  });
});

describe('perspectiveOf', () => {
  it('is the topic of a perspective run only', () => {
    expect(perspectiveOf({ variant: { kind: 'perspective', topic: 'AI' } })).toEqual({
      perspective: 'AI',
    });
    expect(perspectiveOf({ variant: { kind: 'complete', topic: 'AI' } })).toEqual({});
    expect(perspectiveOf({ variant: { kind: 'perspective' } })).toEqual({});
    expect(perspectiveOf({})).toEqual({});
  });
});
