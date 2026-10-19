import { describe, expect, it } from 'vitest';
import { loggedId } from './loggedId';

describe('loggedId', () => {
  it('keeps a short id as it is', () => {
    expect(loggedId('item-1')).toBe('item-1');
  });

  it('cuts a long id that the model wrote, so a log line stays short', () => {
    const logged = loggedId('x'.repeat(5_000));

    expect(logged.length).toBeLessThanOrEqual(80);
    expect(logged.endsWith('...')).toBe(true);
  });
});
