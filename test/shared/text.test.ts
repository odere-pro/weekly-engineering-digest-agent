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

  describe('markup', () => {
    it('strips tags that carry attributes and span lines', () => {
      expect(toPlainText('<a\n  href="https://x.test/?a=1&amp;b=2"\n>link</a> after')).toBe(
        'link after',
      );
    });

    it('drops script and style blocks whatever their case or attributes', () => {
      const html = 'a<SCRIPT type="text/x">1 < 2</Script>b<style media="all">p{}</style>c';
      expect(toPlainText(html)).toBe('a b c');
    });

    it('drops every block, not only the first', () => {
      expect(toPlainText('<script>1</script>x<script>2</script>y<style>3</style>z')).toBe('x y z');
    });

    it('drops everything after a script block that is never closed', () => {
      expect(toPlainText('before <script>alert(1) <b>after</b>')).toBe('before');
    });

    it('drops everything after a style block that is never closed', () => {
      expect(toPlainText('before <STYLE>p { color: red } after')).toBe('before');
    });

    it('drops everything after a script tag that never ends', () => {
      expect(toPlainText('before <script src="x" after')).toBe('before');
    });

    it('keeps what comes after the first block when the second is never closed', () => {
      expect(toPlainText('a<style>x</style>b<script>y c')).toBe('a b');
    });

    it('does not treat a tag that only starts with the word script or style as a block', () => {
      expect(toPlainText('<style-guide>keep</style-guide> <scripted>this</scripted>')).toBe(
        'keep this',
      );
    });

    it('keeps text before a stray "<" and still strips the tag after it', () => {
      expect(toPlainText('x < y <b>z</b>')).toBe('x < y z');
    });

    it('leaves "<>" and a "<" with no closing ">" as text', () => {
      expect(toPlainText('a <> b')).toBe('a <> b');
      expect(toPlainText('<<< hi')).toBe('<<< hi');
    });

    it('decodes an escaped tag to text without stripping it', () => {
      expect(toPlainText('Vec&lt;T&gt; and &lt;b&gt;')).toBe('Vec<T> and <b>');
    });

    it('returns an empty string for markup with no text', () => {
      expect(toPlainText('<br><script>x</script><style>y</style>')).toBe('');
    });
  });

  describe('hostile input', () => {
    const SIZE = 256 * 1024;
    const MAX_MS = 500;

    function repeated(unit: string): string {
      return unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    }

    const hostile: ReadonlyArray<readonly [string, string]> = [
      ['"<" only', repeated('<')],
      ['"<" and letters, never closed', repeated('<a')],
      ['"<" and spaces, never closed', repeated('< ')],
      ['"<a " with no ">"', repeated('<a ')],
      ['unclosed <script>', repeated('<script>')],
      ['unclosed <style>', repeated('<style>')],
      ['"<script" with no ">"', repeated('<script ')],
      ['"<script>" opened, ">" far away', `${repeated('<script ')}>`],
      ['empty script blocks', repeated('<script></script>')],
      ['script blocks with long bodies', repeated(`<script>${'x'.repeat(100)}</script>`)],
      ['close tags without openers', repeated('</script>')],
      ['one long unclosed tag', `<a ${'x'.repeat(SIZE)}`],
      ['"&" runs', repeated('&')],
      ['"&#x" runs', repeated('&#x')],
      ['one long entity name', `&${'a'.repeat(SIZE)}`],
      ['whitespace only', repeated(' \n\t')],
    ];

    it.each(hostile)('reads %s in linear time', (_name, input) => {
      const startedAt = performance.now();
      toPlainText(input);
      expect(performance.now() - startedAt).toBeLessThan(MAX_MS);
    });

    it('still strips a tag at the very end of a large text', () => {
      expect(toPlainText(`${'word '.repeat(50_000)}<b>end</b>`).endsWith('word end')).toBe(true);
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
