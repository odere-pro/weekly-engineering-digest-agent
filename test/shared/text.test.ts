import { describe, expect, it } from 'vitest';
import { toPlainText, truncate, wordCount } from '../../src/shared/text.js';

describe('text helpers', () => {
  it('strips tags, scripts and decodes entities', () => {
    const html =
      '<p>Hello&nbsp;<b>world</b> &amp; &#x41;&#66; &unknown;</p><script>alert(1)</script>';
    expect(toPlainText(html)).toBe('Hello world & AB &unknown;');
  });

  it('truncates at a word boundary', () => {
    expect(truncate('one two three four', 100)).toBe('one two three four');
    expect(truncate('one two three four', 12)).toBe('one two...');
    expect(truncate('abcdefghijklmnop', 8)).toBe('abcde...');
  });

  it('counts words', () => {
    expect(wordCount('  a b\n c ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});
