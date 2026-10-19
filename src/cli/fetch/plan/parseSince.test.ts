import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { parseSince } from './parseSince';

describe('parseSince', () => {
  it('leaves the window to the config when there is no --since', () => {
    expect(parseSince(undefined)).toBeUndefined();
  });

  it.each([
    ['1d', 1],
    ['7d', 7],
    ['30d', 30],
    ['31d', 31],
    ['07d', 7],
  ])('reads %s as %i days', (since, days) => {
    expect(parseSince(since)).toBe(days);
  });

  it.each(['week', '0d', '32d', '100d', '7', '-3d', '1.5d', '', '7D', ' 7d', '7d ', '7dd', 'd'])(
    'refuses "%s" and says what is accepted',
    (since) => {
      expect(() => parseSince(since)).toThrow(DigestError);
      expect(() => parseSince(since)).toThrow(
        `Invalid --since "${since}". Use a number of days from 1d to 31d, for example 7d.`,
      );
    },
  );
});
