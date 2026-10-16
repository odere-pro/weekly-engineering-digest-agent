import { describe, expect, it } from 'vitest';
import { renderDigest } from '../../src/core/render.js';
import { makeDigest, makeItem } from '../builders.js';

describe('renderDigest', () => {
  const items = [makeItem(), makeItem(), makeItem()];
  const digest = makeDigest(items);

  it('renders headline, week, intro and numbered items without a footer', () => {
    const md = renderDigest(digest, { disabledGuards: [] });
    const first = digest.items[0]!;

    expect(md.startsWith(`# ${digest.headline}\n\n_Week 2026-W42_\n\n${digest.intro}\n`)).toBe(
      true,
    );
    expect(md).toContain(
      `## 1. ${first.title}\n\n${first.summary}\n\n**Why it matters:** ${first.whyItMatters}\n\n[Source](${first.url})`,
    );
    expect(md).toContain('## 3. ');
    expect(md).not.toContain('---');
    expect(md).not.toContain('Guards off');
  });

  it('adds a footer naming the disabled guards', () => {
    const md = renderDigest(digest, { disabledGuards: ['clefPolicy', 'graniteRisk'] });

    expect(md.trimEnd().endsWith('---\n\nGuards off this week: clefPolicy, graniteRisk.')).toBe(
      true,
    );
  });
});
