import { describe, expect, it } from 'vitest';
import { safeSourceText } from './sourceText';

describe('safeSourceText', () => {
  it.each([
    ['Runner v1.2.0 ships faster builds.'],
    ['Kubernetes 1.31: a patch release (CVE-2026-1234)'],
    ['100% of the tests pass; 5 < 6 and 7 > 3'],
    ['a/b and c.d and file.txt'],
    [''],
  ])('leaves clean text as it is: %j', (text) => {
    expect(safeSourceText(text)).toBe(text);
  });

  it.each([
    ['a url', 'See https://evil.example/x now', 'See now'],
    ['an http url in capitals', 'See HTTP://EVIL.EXAMPLE now', 'See now'],
    ['an ftp url', 'Get ftp://evil.example/p now', 'Get now'],
    ['a scheme with no slashes', 'See http:evil.example now', 'See now'],
    ['an https scheme with no slashes', 'See https:evil now', 'See now'],
    ['an ftp scheme with no slashes', 'Get ftp:evil now', 'Get now'],
    ['a scheme-less address', 'Go //evil.example/q now', 'Go now'],
    ['a www address', 'Docs at www.evil.test/x now', 'Docs at now'],
    ['a mailto link', 'Write mailto:a@evil.example now', 'Write now'],
    ['a javascript link', 'Run javascript:alert(1) now', 'Run now'],
    ['a Markdown link', 'Read [docs](x) now', 'Read now'],
    ['a numeric character reference', 'Ok &#99999999; now', 'Ok now'],
    ['a hex character reference', 'Ok &#x41; now', 'Ok now'],
    ['a named character reference', 'Fish &amp; chips', 'Fish chips'],
  ])('drops a token with %s, which the link check would read as a link', (_name, text, kept) => {
    expect(safeSourceText(text)).toBe(kept);
  });

  it('makes one line of single spaces', () => {
    expect(safeSourceText('  one\n\ttwo   three \r\n')).toBe('one two three');
  });

  it('keeps a word that only looks like a scheme or a reference', () => {
    expect(safeSourceText('the http protocol, a & b, and 5 &lt 6')).toBe(
      'the http protocol, a & b, and 5 &lt 6',
    );
  });

  it('is empty when no usable token is left', () => {
    expect(safeSourceText('https://evil.example/x www.evil.test &#99;')).toBe('');
    expect(safeSourceText('  \n ')).toBe('');
  });

  it('drops every link-like token of a text, however many there are', () => {
    expect(safeSourceText('https://a one https://b two https://c')).toBe('one two');
    expect(safeSourceText('https://a https://b https://c')).toBe('');
  });
});

describe('safeSourceText on hostile input', () => {
  const LONG = 100_000;

  it.each([
    ['link-like tokens', 'https://x '.repeat(LONG / 10)],
    ['character references', '&#9; '.repeat(LONG / 5)],
    ['one long token', `a${'.'.repeat(LONG)}`],
    ['one long link-like token', `x${'/'.repeat(LONG)}`],
    ['ampersands', '&'.repeat(LONG)],
    ['reference starts', '&#a'.repeat(LONG / 3)],
    ['brackets', '](['.repeat(LONG / 3)],
    ['whitespace', ' \n'.repeat(LONG / 2)],
  ])('stays fast on %s', (_name, text) => {
    const started = performance.now();

    safeSourceText(text);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
