import { describe, expect, it } from 'vitest';
import { visibleText } from './visibleText';

const ZWJ = '\u{200D}';
const MAN_TECHNOLOGIST = `\u{1F468}${ZWJ}\u{1F4BB}`;

describe('visibleText', () => {
  // Characters that reorder or hide the text around them. U+E0041 is a tag character: it has no
  // glyph, so a whole hidden sentence can be spelled with them.
  const INVISIBLE = [
    ['bidi right-to-left override', 0x202e],
    ['bidi left-to-right isolate', 0x2066],
    ['zero-width space', 0x200b],
    ['byte order mark', 0xfeff],
    ['soft hyphen', 0x00ad],
    ['tag letter A', 0xe0041],
    ['Arabic letter mark', 0x061c],
  ] as const;

  it.each(INVISIBLE)(
    'removes the %s from a line, leaving a space where it stood',
    (_name, code) => {
      const text = `Ship${String.fromCodePoint(code)}it`;

      const result = visibleText(text);

      expect(result).toBe('Ship it');
      expect(result).not.toContain(String.fromCodePoint(code));
    },
  );

  it('turns a run of invisible characters into one space', () => {
    expect(visibleText('A\u{202E}\u{200B}\u{206A}\u{E0041}\u{2066}B')).toBe('A B');
  });

  it('keeps every newline, so the lines of a Markdown text stay what they were', () => {
    const text = '# Title\n\n- one\n- two\n\n\nlast line\n';

    expect(visibleText(text)).toBe(text);
  });

  it('keeps the line structure around invisible characters', () => {
    expect(visibleText('a\u{202E}\nb\u{200B}\n\u{FEFF}c\n\u{2066}\n')).toBe('a\nb\nc\n\n');
  });

  it('reads a carriage return before a newline as part of the line break', () => {
    expect(visibleText('# Title\r\n\r\nbody\r\n')).toBe('# Title\n\nbody\n');
  });

  it('turns a lone carriage return and the other line separators into a space, not a break', () => {
    expect(visibleText('a\rb\u{2028}c\u{2029}d\u{85}e\u{B}f\u{C}g')).toBe('a b c d e f g');
  });

  it('trims the trailing spaces of every line and keeps the indentation', () => {
    expect(visibleText('  - nested   \n\t- tabbed\t\n   \nend  ')).toBe(
      '  - nested\n\t- tabbed\n\nend',
    );
  });

  it('turns a tab inside a line into a space', () => {
    expect(visibleText('a\tb')).toBe('a b');
  });

  it('leaves no trace of a control character at the start or end of the text', () => {
    expect(visibleText('\u{0}\u{7}text\u{1B}')).toBe('text');
  });

  describe('zero-width joiner', () => {
    it('keeps the joiner of an emoji joined from two, so the emoji shows whole', () => {
      expect(visibleText(`built by ${MAN_TECHNOLOGIST} today`)).toBe(
        `built by ${MAN_TECHNOLOGIST} today`,
      );
    });

    it('keeps a joined emoji on every line of a text', () => {
      const text = `${MAN_TECHNOLOGIST}\n- ${MAN_TECHNOLOGIST} shipped\n`;

      expect(visibleText(text)).toBe(text);
    });

    it('keeps a family of three and an emoji with a skin tone or a variation selector', () => {
      const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
      const skin = `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`;
      const flag = `\u{1F3F3}\u{FE0F}${ZWJ}\u{1F308}`;

      expect(visibleText(`${family}\n${skin}\n${flag}`)).toBe(`${family}\n${skin}\n${flag}`);
    });

    it.each([
      ['inside a word', `ig${ZWJ}nore`, 'ig nore'],
      ['between a letter and an emoji', `a${ZWJ}\u{1F4BB}`, 'a \u{1F4BB}'],
      ['at the end of a line', `\u{1F4BB}${ZWJ}\nnext`, '\u{1F4BB}\nnext'],
      ['doubled between emoji', `\u{1F468}${ZWJ}${ZWJ}\u{1F469}`, '\u{1F468} \u{1F469}'],
      ['next to a bidi override', `\u{1F468}${ZWJ}\u{202E}\u{1F469}`, '\u{1F468} \u{1F469}'],
      ['across a line break', `\u{1F468}${ZWJ}\n\u{1F469}`, '\u{1F468}\n\u{1F469}'],
    ])('removes a joiner %s', (_name, text, expected) => {
      expect(visibleText(text)).toBe(expected);
    });
  });

  it('leaves plain text unchanged: letters, digits, punctuation, accents, emoji and Markdown', () => {
    const text =
      '## Zürich 2.0: “fast” – naïve café \u{1F680}\u{FE0F} 日本語\n\n' +
      '- **bold** and [a link](https://example.com/a?b=1&c=2) #42\n' +
      '  - nested item\n';

    expect(visibleText(text)).toBe(text);
  });

  it('is the identity on an empty string', () => {
    expect(visibleText('')).toBe('');
  });

  describe('on hostile input', () => {
    const SIZE = 100_000;

    it.each([
      ['a run of zero-width spaces', '\u{200B}'.repeat(SIZE)],
      ['bidi overrides between spaces', ' \u{202E}'.repeat(SIZE / 2)],
      ['a long run of spaces, then a word', `a${' '.repeat(SIZE)}b`],
      ['a long run of spaces at the end of a line', `${'a '.repeat(10)}${' '.repeat(SIZE)}\nb`],
      ['nothing but line breaks', '\n'.repeat(SIZE)],
      ['carriage returns and line breaks', '\r\n'.repeat(SIZE / 2)],
      ['a joiner after every emoji', `\u{1F468}${ZWJ}`.repeat(SIZE / 3)],
      ['joined emoji with a bidi mark between', `\u{1F468}${ZWJ}\u{202E}`.repeat(SIZE / 4)],
      ['a joiner after every letter', `a${ZWJ}`.repeat(SIZE / 2)],
      ['a line of indentation and invisible characters', `\t \u{200B}`.repeat(SIZE / 3)],
    ])('stays linear on %s', (_name, input) => {
      const started = performance.now();
      visibleText(input);

      expect(performance.now() - started).toBeLessThan(1000);
    });
  });
});
