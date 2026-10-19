// safeText and oneLine print text a model or a feed wrote: they must never pass a character that
// moves the cursor, recolors the terminal or reorders what is read.
import { describe, expect, it } from 'vitest';
import { MAX_PRINTED_PROBLEM_CHARS, oneLine, plural, safeText } from './printable';

describe('safeText', () => {
  it.each([
    ['a newline, a tab and a carriage return', 'a\nb\tc\rd', 'a b c d'],
    ['an escape sequence', 'red\u{1b}[31m text', 'red [31m text'],
    ['NUL and BEL', 'a\u{0}b\u{7}c', 'a b c'],
    ['DEL', 'a\u{7f}b', 'a b'],
    ['C1 controls, first and last', 'a\u{80}b\u{9f}c', 'a b c'],
    ['a line and a paragraph separator', 'a\u{2028}b\u{2029}c', 'a b c'],
    ['zero-width characters and direction marks', 'a\u{200B}b\u{200E}c\u{200F}d', 'a b c d'],
    ['bidirectional embeddings and overrides', 'a\u{202A}b\u{202E}c', 'a b c'],
    ['bidirectional isolates', 'a\u{2066}b\u{2069}c', 'a b c'],
    ['the first and last tag characters', 'a\u{E0000}b\u{E007F}c', 'a b c'],
    ['an unassigned tag code point', 'a\u{E0002}b', 'a b'],
    ['a tag-character message hidden in a word', 'ok\u{E0041}\u{E0042}\u{E0043}ok', 'ok ok'],
    ['the Arabic letter mark', 'a\u{061C}b', 'a b'],
    ['the word joiner and the invisible operators', 'a\u{2060}b\u{2064}c', 'a b c'],
    ['the deprecated format characters', 'a\u{206A}b\u{206F}c', 'a b c'],
    ['the byte order mark', 'a\u{FEFF}b', 'a b'],
    ['the soft hyphen', 'a\u{00AD}b', 'a b'],
  ])('replaces %s with a space', (_name, text, printed) => {
    expect(safeText(text)).toBe(printed);
  });

  it('replaces a run of unsafe characters with one space', () => {
    expect(safeText('a\n\n\u{1b}[0m\u{202E}\u{200B}b')).toBe('a [0m b');
  });

  it('replaces a run of the characters the old list missed with one space', () => {
    expect(safeText('a\u{061C}\u{2060}\u{FEFF}\u{00AD}\u{206F}b')).toBe('a b');
  });

  it('keeps an emoji without a joiner', () => {
    expect(safeText('\u{1F680} ok')).toBe('\u{1F680} ok');
  });

  it('trims the ends, so a trailing newline or a leading mark leaves no space', () => {
    expect(safeText('\u{202E}text\n')).toBe('text');
    expect(safeText('\n\u{200B}')).toBe('');
  });

  it('keeps the characters next to the unsafe ranges', () => {
    const neighbours = ['\u{A0}', '\u{200A}', '\u{202F}', '\u{2027}', '\u{2070}', '\u{E0080}'];
    for (const char of neighbours) expect(safeText(`a${char}b`)).toBe(`a${char}b`);
  });

  it('keeps ordinary text, accents, CJK and emoji untouched', () => {
    const text = 'Zürich: 日本語 \u{2713} \u{1F600} \u{201C}quoted\u{201D} \u{2014} dash';
    expect(safeText(text)).toBe(text);
  });
});

describe('oneLine', () => {
  it('cleans the text like safeText', () => {
    expect(oneLine('bad\nline\u{1b}[31m red\ttab')).toBe('bad line [31m red tab');
  });

  it('keeps a text that fits', () => {
    const text = 'x'.repeat(MAX_PRINTED_PROBLEM_CHARS);
    expect(oneLine(text)).toBe(text);
  });

  it('cuts a long text to the limit, with "..." at the end', () => {
    const cut = oneLine('x'.repeat(MAX_PRINTED_PROBLEM_CHARS + 80));
    expect(cut).toHaveLength(MAX_PRINTED_PROBLEM_CHARS);
    expect(cut.endsWith('...')).toBe(true);
  });

  it('cleans before it measures, so removed characters do not count', () => {
    const text = `${'\u{202E}'.repeat(200)}short`;
    expect(oneLine(text)).toBe('short');
  });

  it('does not split an emoji when it cuts', () => {
    const cut = oneLine(`${'a'.repeat(116)}\u{1F600}tail`);
    expect(cut).toBe(`${'a'.repeat(116)}...`);
  });
});

describe('plural', () => {
  it('says "1 item" for one', () => {
    expect(plural(1, 'item')).toBe('1 item');
  });

  it.each([0, 2, 7])('adds an s for %i', (count) => {
    expect(plural(count, 'problem')).toBe(`${count} problems`);
  });
});
