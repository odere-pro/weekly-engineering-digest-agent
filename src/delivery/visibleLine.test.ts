import { describe, expect, it } from 'vitest';
import { visibleLine } from './visibleLine';

const ZWJ = '\u{200D}';

describe('visibleLine', () => {
  it('turns line breaks, tabs and control characters into single spaces and trims the ends', () => {
    expect(visibleLine('  a\n\nb\t\r\nc\u{0}\u{7}d\u{85}e  ')).toBe('a b c d e');
  });

  it('returns an empty string when only blanks and invisible characters are left', () => {
    expect(visibleLine(' \n\t\u{0} \u{200B}\u{FEFF}\u{202E} ')).toBe('');
  });

  // Format characters that change the order or the look of the text around them, or that hide
  // text: bidi marks, embeddings, overrides and isolates (the old and the new set), joiners,
  // word and invisible operators, the byte order mark, the soft hyphen and the tag characters.
  const FORMAT_CHARACTERS = [
    0x00ad, 0x061c, 0x200b, 0x200c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2028,
    0x2029, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d,
    0x206e, 0x206f, 0xfeff, 0xe0001, 0xe0020, 0xe0041, 0xe007f,
  ] as const;

  it.each(FORMAT_CHARACTERS.map((codePoint) => [codePoint.toString(16), codePoint] as const))(
    'replaces the invisible character U+%s, so it cannot reorder or hide text',
    (_hex, codePoint) => {
      expect(visibleLine(`A${String.fromCodePoint(codePoint)}B`)).toBe('A B');
    },
  );

  it('turns a run of invisible characters into one space', () => {
    expect(visibleLine('A\u{202E}\u{200B}\u{206A}\u{E0041}B')).toBe('A B');
  });

  describe('zero-width joiner', () => {
    const WOMAN_TECHNOLOGIST = `\u{1F469}${ZWJ}\u{1F4BB}`;
    const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
    const WOMAN_TECHNOLOGIST_MEDIUM_SKIN = `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`;
    const RAINBOW_FLAG = `\u{1F3F3}\u{FE0F}${ZWJ}\u{1F308}`;
    const HEART_ON_FIRE = `\u{2764}\u{FE0F}${ZWJ}\u{1F525}`;

    it.each([
      ['a person and an object', WOMAN_TECHNOLOGIST],
      ['three people', FAMILY],
      ['a skin tone before the joiner', WOMAN_TECHNOLOGIST_MEDIUM_SKIN],
      ['a variation selector before the joiner', RAINBOW_FLAG],
      ['a text-style base with a variation selector', HEART_ON_FIRE],
    ])('keeps the joiner that makes one emoji of %s', (_name, emoji) => {
      expect(visibleLine(`shipped by ${emoji} today`)).toBe(`shipped by ${emoji} today`);
    });

    it.each([
      ['inside a word', `ig${ZWJ}nore`, 'ig nore'],
      ['between a letter and an emoji', `a${ZWJ}\u{1F4BB}`, 'a \u{1F4BB}'],
      ['between an emoji and a letter', `\u{1F4BB}${ZWJ}a`, '\u{1F4BB} a'],
      ['at the start', `${ZWJ}\u{1F4BB}`, '\u{1F4BB}'],
      ['at the end', `\u{1F4BB}${ZWJ}`, '\u{1F4BB}'],
      ['after a space', `\u{1F4BB} ${ZWJ}\u{1F469}`, '\u{1F4BB} \u{1F469}'],
      ['doubled between emoji', `\u{1F468}${ZWJ}${ZWJ}\u{1F469}`, '\u{1F468} \u{1F469}'],
      [
        'next to another invisible character',
        `\u{1F468}${ZWJ}\u{200B}\u{1F469}`,
        '\u{1F468} \u{1F469}',
      ],
    ])('removes a joiner %s', (_name, text, expected) => {
      expect(visibleLine(text)).toBe(expected);
    });

    it('does not let a kept joiner hide a bidi override next to it', () => {
      expect(visibleLine(`\u{1F468}${ZWJ}\u{202E}\u{1F469}`)).toBe('\u{1F468} \u{1F469}');
    });
  });

  it('keeps letters, digits, punctuation, accents and emoji without a joiner', () => {
    const text = 'Zürich 2.0: “fast” – naïve café \u{1F680}\u{FE0F} 日本語';

    expect(visibleLine(text)).toBe(text);
  });
});
