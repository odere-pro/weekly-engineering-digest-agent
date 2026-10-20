import { describe, expect, it } from 'vitest';
import { cutSummary, titleOf } from './sourceLine';

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe('cutSummary', () => {
  it('keeps whole sentences that fit under the word limit', () => {
    const text = 'one two three four five. six seven eight nine ten.';

    expect(cutSummary(text, 6)).toBe('one two three four five.');
    expect(cutSummary(text, 10)).toBe(text);
  });

  it('leaves no href attribute, even one a backslash tried to hide', () => {
    expect(cutSummary('See href\\=/x and src = "/y" now.', 30)).not.toMatch(/\b(?:href|src)\s*=/i);
  });

  it('cuts a first sentence that is too long at a word, with an ellipsis', () => {
    const cut = cutSummary('word '.repeat(100).trim() + '.', 10);

    expect(words(cut)).toBe(10);
    expect(cut.endsWith('...')).toBe(true);
  });

  it('drops links, em dashes, pipes and character references from the text', () => {
    const cut = cutSummary('See https://evil.example/x now — a|b www.evil.test &#99; done.', 40);

    expect(cut).toBe('See now - a b done.');
  });

  it('gives a fixed line for an empty summary', () => {
    expect(cutSummary('   ', 40)).toBe('No summary in the source.');
  });
});

describe('titleOf', () => {
  it('shows the url for a blank title', () => {
    expect(titleOf({ title: ' | ', url: 'https://a.example/x' })).toBe('https://a.example/x');
  });

  it('drops link-like tokens from the title', () => {
    expect(titleOf({ title: 'Runner https://evil.example v2', url: 'https://a.example' })).toBe(
      'Runner v2',
    );
  });
});
