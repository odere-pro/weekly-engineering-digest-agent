import { describe, expect, it } from 'vitest';
import { keysCutAtHash } from './keysCutAtHash';

describe('keysCutAtHash', () => {
  it('finds an unquoted value with a "#", with or without a space before it', () => {
    expect(keysCutAtHash('A=one #two\nB=three#four\n')).toEqual([
      { key: 'A', line: 1 },
      { key: 'B', line: 2 },
    ]);
  });

  it('returns only the key and the 1-based line, never the value', () => {
    const found = keysCutAtHash('SMTP_PASSWORD=correct horse #battery staple\n');

    expect(found).toEqual([{ key: 'SMTP_PASSWORD', line: 1 }]);
    expect(JSON.stringify(found)).not.toContain('battery');
  });

  it('reports a key once, at its first line', () => {
    expect(keysCutAtHash('A=x#1\nB=ok\nA=y#2\n')).toEqual([{ key: 'A', line: 1 }]);
  });

  it('accepts export, spaces around the equals sign and CRLF line ends', () => {
    expect(keysCutAtHash('export A = x#1\r\nB=fine\r\n')).toEqual([{ key: 'A', line: 1 }]);
  });

  it.each(['"', "'", '`'])('ignores a "#" inside a value quoted with %s', (quote) => {
    expect(keysCutAtHash(`A=${quote}x #y${quote}\n`)).toEqual([]);
  });

  it('ignores comment lines, empty values and lines that are not assignments', () => {
    const text = ['# A=x #y', '   # B=c #d', 'EMPTY=', 'not an assignment #', '=novalue#', ''].join(
      '\n',
    );

    expect(keysCutAtHash(text)).toEqual([]);
  });

  it('skips the lines of a quoted value that spans several lines', () => {
    expect(keysCutAtHash('KEY="first\nsecond # line\nthird"\nNEXT=v#w\n')).toEqual([
      { key: 'NEXT', line: 4 },
    ]);
  });

  it('keeps reading after a quote that nothing closes, as the parser does', () => {
    expect(keysCutAtHash('BROKEN="never closed\nPASS=pa#ss\n')).toEqual([{ key: 'PASS', line: 2 }]);
  });

  it('closes a quote at the next quote of the same kind, even on another key', () => {
    const text = 'A="opens\nB=1 #hidden\nC=\'x\'\nD="closes A"\nE=v#w\n';

    expect(keysCutAtHash(text)).toEqual([{ key: 'E', line: 5 }]);
  });

  it('returns an empty list for an empty file', () => {
    expect(keysCutAtHash('')).toEqual([]);
  });
});
