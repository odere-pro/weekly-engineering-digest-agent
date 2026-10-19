import { describe, expect, it } from 'vitest';
import { escapeHtml, httpUrl, oneLine, titleOf } from './safeText';
import { item, NOT_HTTP_URLS } from './__fixtures__/emailKit';

describe('oneLine', () => {
  it('turns line breaks, tabs and control characters into single spaces and trims the ends', () => {
    expect(oneLine('  a\n\nb\t\r\nc\u0000\u0007d  ')).toBe('a b c d');
  });

  // U+202A to U+202E (embeddings and overrides) and U+2066 to U+2069 (isolates).
  const BIDI_CONTROLS = [
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ] as const;

  it.each(BIDI_CONTROLS.map((codePoint) => [codePoint.toString(16), codePoint] as const))(
    'replaces the bidirectional control U+%s, so it cannot reorder the text around it',
    (_hex, codePoint) => {
      expect(oneLine(`A${String.fromCodePoint(codePoint)}B`)).toBe('A B');
    },
  );

  it('keeps other format characters, so a zero-width-joiner emoji stays whole', () => {
    const family = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);

    expect(oneLine(`by ${family}`)).toBe(`by ${family}`);
  });

  it('returns an empty string when only blanks are left', () => {
    expect(oneLine(' \n\t\u0000 ')).toBe('');
  });
});

describe('titleOf', () => {
  it('is the title on one line', () => {
    expect(titleOf(item({ title: 'Real\n- Fake title' }))).toBe('Real - Fake title');
  });

  it('is a placeholder when nothing is left of the title', () => {
    expect(titleOf(item({ title: ' \n\u0000 ' }))).toBe('(untitled)');
    expect(titleOf(item({ title: '' }))).toBe('(untitled)');
  });
});

describe('httpUrl', () => {
  it.each([
    ['http://example.com/ok', 'http://example.com/ok'],
    ['HTTPS://Example.com/Path?q=1', 'https://example.com/Path?q=1'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/?a=1&b=2', 'https://example.com/?a=1&b=2'],
  ])('returns %j in its normalised form', (raw, expected) => {
    expect(httpUrl(raw)).toBe(expected);
  });

  it('percent-encodes a quote and angle brackets, so the URL cannot close an attribute', () => {
    expect(httpUrl('https://example.com/a?x="><b>')).toBe('https://example.com/a?x=%22%3E%3Cb%3E');
  });

  it.each(NOT_HTTP_URLS)('refuses %j', (raw) => {
    expect(httpUrl(raw)).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in element text and in attribute values', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes an ampersand once, so an entity-like input is not read back as another character', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves other text alone', () => {
    expect(escapeHtml('plain text, 100% — ok')).toBe('plain text, 100% — ok');
  });
});
