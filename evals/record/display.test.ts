import { describe, expect, it } from 'vitest';
import { oneLine, pluralizeItems } from './display';

describe('oneLine', () => {
  it('turns every run of whitespace, line breaks included, into one space', () => {
    expect(oneLine('a  b\n c\r\n\td')).toBe('a b c d');
  });

  it('trims both ends', () => {
    expect(oneLine('  \n text \t ')).toBe('text');
  });

  it('is empty for text of whitespace only', () => {
    expect(oneLine(' \n\t ')).toBe('');
  });
});

describe('pluralizeItems', () => {
  it.each([
    [0, '0 items'],
    [1, '1 item'],
    [2, '2 items'],
    [10, '10 items'],
  ])('writes %i as "%s"', (count, text) => {
    expect(pluralizeItems(count)).toBe(text);
  });
});
