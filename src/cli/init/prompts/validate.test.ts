import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isEmail, splitList, validateWith } from './validate';

describe('validateWith', () => {
  const validate = validateWith(z.string().min(1), 'host name');

  it('accepts a value the schema accepts', () => {
    expect(validate('smtp.example.com')).toBe(true);
  });

  it('names what was expected when the schema refuses', () => {
    expect(validate('')).toBe('Enter a valid host name');
  });

  it('checks the trimmed value, as the answer is stored trimmed', () => {
    expect(validate('   ')).toBe('Enter a valid host name');
    expect(validate('  x  ')).toBe(true);
  });
});

describe('isEmail', () => {
  it.each(['digest@example.com', '  digest@example.com  ', 'a.b+c@sub.example.org'])(
    'accepts %j',
    (value) => {
      expect(isEmail(value)).toBe(true);
    },
  );

  it.each(['', 'digest', 'digest@', '@example.com', 'a b@example.com'])('refuses %j', (value) => {
    expect(isEmail(value)).toBe(false);
  });
});

describe('splitList', () => {
  it('splits at commas and trims every part', () => {
    expect(splitList(' ana@example.com ,bo@example.com')).toEqual([
      'ana@example.com',
      'bo@example.com',
    ]);
  });

  it('drops empty parts', () => {
    expect(splitList(',, a ,,b,')).toEqual(['a', 'b']);
    expect(splitList('')).toEqual([]);
    expect(splitList('   ')).toEqual([]);
  });

  it('keeps one value whole', () => {
    expect(splitList('Cloud native tooling')).toEqual(['Cloud native tooling']);
  });
});
