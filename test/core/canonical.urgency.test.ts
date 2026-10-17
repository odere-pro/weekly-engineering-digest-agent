import { describe, expect, it } from 'vitest';
import { canonicalClaimText, canonicalDigestText } from '../../src/core/canonical.js';
import type { DigestItem } from '../../src/core/schemas.js';
import { makeDigest, makeDigestItem, makeItem } from '../builders.js';

const source = makeItem({ title: 'OpenTofu 1.9.1', url: 'https://example.com/tofu' });
const item = (patch: Partial<DigestItem> = {}): DigestItem =>
  makeDigestItem(source, { area: 'Platform', summary: 'S.', whyItMatters: 'W.', ...patch });

describe('canonicalDigestText urgency and action (W8-01)', () => {
  it('shows the urgency after the area and the action after why-it-matters', () => {
    const text = canonicalDigestText(
      makeDigest([source], {
        headline: 'H',
        intro: 'I',
        items: [item({ urgency: 'act-now', action: 'Upgrade OpenTofu in CI and on laptops' })],
      }),
    );

    expect(text).toBe(
      [
        'Headline: H',
        'Intro: I',
        [
          'Title: OpenTofu 1.9.1',
          'Area: Platform',
          'Urgency: act-now',
          'Summary: S.',
          'Why it matters: W.',
          'Action: Upgrade OpenTofu in CI and on laptops',
          'URL: https://example.com/tofu',
        ].join('\n'),
      ].join('\n\n'),
    );
  });

  it.each([
    ['an empty action', ''],
    ['a blank action', '   '],
    ['no action', undefined],
  ])('leaves the action line out for %s but keeps the urgency', (_name, action) => {
    const text = canonicalDigestText(
      makeDigest([source], { items: [item({ urgency: 'good-to-know', action })] }),
    );

    expect(text).toContain('Urgency: good-to-know');
    expect(text).not.toContain('Action:');
  });

  it('is byte for byte what W7-04 produced for an item with no urgency and no action', () => {
    const text = canonicalDigestText(
      makeDigest([source], { headline: 'H', intro: 'I', items: [item()] }),
    );

    expect(text).toBe(
      [
        'Headline: H',
        'Intro: I',
        'Title: OpenTofu 1.9.1\nArea: Platform\nSummary: S.\nWhy it matters: W.\nURL: https://example.com/tofu',
      ].join('\n\n'),
    );
  });

  it('shows every urgency value as it is written', () => {
    for (const urgency of ['act-now', 'worth-a-look', 'good-to-know'] as const) {
      const text = canonicalDigestText(makeDigest([source], { items: [item({ urgency })] }));

      expect(text).toContain(`Urgency: ${urgency}\n`);
    }
  });
});

describe('canonicalClaimText action (W8-01)', () => {
  it('adds the action line, so the groundedness guard checks it too', () => {
    expect(canonicalClaimText(item({ action: 'Upgrade OpenTofu in CI' }))).toBe(
      'S.\nW.\nUpgrade OpenTofu in CI',
    );
  });

  it.each([undefined, '', '  '])('is unchanged from W5-11 when the action is %j', (action) => {
    expect(canonicalClaimText(item({ urgency: 'good-to-know', action }))).toBe('S.\nW.');
  });
});
