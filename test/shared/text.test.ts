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

  describe('numeric entities', () => {
    it('leaves a code point above U+10FFFF as the literal text instead of throwing', () => {
      expect(toPlainText('<p>a &#x110000; b &#1114112; c</p>')).toBe('a &#x110000; b &#1114112; c');
    });

    it('leaves a number too large to parse safely as the literal text', () => {
      const huge = `&#${'9'.repeat(40)};`;
      expect(toPlainText(`x ${huge} y`)).toBe(`x ${huge} y`);
    });

    it('leaves a lone surrogate code point as the literal text', () => {
      expect(toPlainText('&#xD800; &#55357; &#xDFFF;')).toBe('&#xD800; &#55357; &#xDFFF;');
    });

    it('still decodes the highest valid code point and astral characters', () => {
      expect(toPlainText('&#x1F600; &#128512; &#x10FFFF;')).toBe('\u{1F600} \u{1F600} \u{10FFFF}');
    });

    it('keeps decoding the entities around a bad one', () => {
      expect(toPlainText('&amp; &#x110000; &#65;')).toBe('& &#x110000; A');
    });
  });

  describe('truncate and surrogate pairs', () => {
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it('never leaves half of a surrogate pair when the cut falls inside one', () => {
      // maxChars 11 keeps 8 code units: seven "a" and the high half of the first emoji.
      const result = truncate(`aaaaaaa${'\u{1F600}'.repeat(4)}`, 11);
      expect(result).toBe('aaaaaaa...');
      expect(LONE_SURROGATE.test(result)).toBe(false);
    });

    it('keeps a whole pair when the cut falls right after it', () => {
      const result = truncate(`aaaaaa${'\u{1F600}'.repeat(4)}`, 11);
      expect(result).toBe('aaaaaa\u{1F600}...');
      expect(result.length).toBeLessThanOrEqual(11);
    });

    it('stays within maxChars for every cut position in an emoji-only text', () => {
      const text = '\u{1F600}'.repeat(20);
      for (let max = 3; max < text.length; max += 1) {
        const result = truncate(text, max);
        expect(result.length).toBeLessThanOrEqual(max);
        expect(LONE_SURROGATE.test(result)).toBe(false);
      }
    });
  });

  it('counts words', () => {
    expect(wordCount('  a b\n c ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});
