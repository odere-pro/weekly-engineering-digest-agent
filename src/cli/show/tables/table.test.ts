import { describe, expect, it } from 'vitest';
import { cell, clean, formatScore, MAX_CELL_CHARS, table } from './table';

describe('table', () => {
  it('pads each column to its widest cell and puts two spaces between columns', () => {
    const text = table([
      ['Name', 'N'],
      ['alpha', '1'],
      ['b', '22'],
    ]);
    expect(text).toBe(['Name   N', 'alpha  1', 'b      22', ''].join('\n'));
  });

  it('leaves no trailing spaces, even after an empty last cell', () => {
    const text = table([
      ['Key', 'Value'],
      ['a', ''],
    ]);
    expect(text).toBe('Key  Value\na\n');
  });

  it('prints a header alone', () => {
    expect(table([['Source', 'Title']])).toBe('Source  Title\n');
  });

  it('measures the widest cell over every row, not only the header', () => {
    const text = table([
      ['A', 'B'],
      ['long cell', 'x'],
      ['s', 'y'],
    ]);
    expect(text.split('\n')).toEqual(['A          B', 'long cell  x', 's          y', '']);
  });
});

describe('table with ragged rows', () => {
  it('prints a row shorter than the header without padding the missing cells', () => {
    expect(table([['A', 'B'], ['x']])).toBe('A  B\nx\n');
  });

  it('prints the cells of a row longer than the header unpadded', () => {
    expect(table([['A'], ['x', 'extra']])).toBe('A\nx  extra\n');
  });
});

describe('cell', () => {
  it('leaves a short plain text as it is', () => {
    expect(cell('Picked release')).toBe('Picked release');
  });

  it('turns control and format characters into spaces, so a feed cannot move the cursor', () => {
    expect(cell('a\u001b[31mb')).toBe('a [31mb');
    expect(cell('line1\nline2\ttab')).toBe('line1 line2 tab');
    expect(cell('x\u202Ey')).toBe('x y');
  });

  it('turns the line and paragraph separators into a space too', () => {
    expect(cell('a\u{2028}b\u{2029}c')).toBe('a b c');
  });

  it('turns a run of unsafe characters into one space and trims the ends', () => {
    expect(cell('\u{202E}a\n\u{1B}\u{200B}b\n')).toBe('a b');
  });

  it('cuts a long text to the cell width and ends it with three dots', () => {
    expect(cell('x'.repeat(MAX_CELL_CHARS * 2))).toBe(`${'x'.repeat(MAX_CELL_CHARS - 3)}...`);
  });

  it('keeps a text of exactly the cell width whole', () => {
    const exact = 'y'.repeat(MAX_CELL_CHARS);
    expect(cell(exact)).toBe(exact);
  });
});

describe('clean', () => {
  it('keeps printable text, newlines, tabs and carriage returns', () => {
    const text = '# Week 2026-W42\n\titem\r\nnext';
    expect(clean(text)).toBe(text);
  });

  it('removes escape codes and C1 controls, so a saved file cannot drive the terminal', () => {
    expect(clean('red\u001b[31mtext')).toBe('red[31mtext');
    expect(clean('x\u009by')).toBe('xy');
    expect(clean('bell\u0007')).toBe('bell');
  });

  it('removes bidi overrides and zero-width characters', () => {
    expect(clean('a\u202Eb\u200Bc')).toBe('abc');
  });
});

describe('formatScore', () => {
  it('prints one decimal', () => {
    expect(formatScore(3)).toBe('3.0');
    expect(formatScore(2.04)).toBe('2.0');
    expect(formatScore(4.26)).toBe('4.3');
  });
});
