import { describe, expect, it } from 'vitest';
import { failureOneLiner, failureTitle } from './failureNote';

describe('failureTitle', () => {
  it('names the week and the step that failed', () => {
    expect(failureTitle({ weekId: '2026-W42', step: 'write', message: 'x' })).toBe(
      'Weekly digest 2026-W42 failed at write',
    );
  });

  it('leaves the step out when it is not known', () => {
    expect(failureTitle({ weekId: '2026-W42', message: 'x' })).toBe(
      'Weekly digest 2026-W42 failed',
    );
  });
});

describe('failureOneLiner', () => {
  it('is the title, a colon and the message', () => {
    expect(failureOneLiner({ weekId: '2026-W42', step: 'write', message: 'model timed out' })).toBe(
      'Weekly digest 2026-W42 failed at write: model timed out',
    );
  });

  it('puts a multi-line message on one line', () => {
    const note = { weekId: '2026-W42', message: '  first line\n\n\tsecond   line  ' };

    expect(failureOneLiner(note)).toBe('Weekly digest 2026-W42 failed: first line second line');
  });

  it('cuts a long message to 300 characters, ending in an ellipsis', () => {
    const note = { weekId: '2026-W42', message: 'word '.repeat(200) };

    const reason = failureOneLiner(note).slice('Weekly digest 2026-W42 failed: '.length);

    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason.length).toBeGreaterThan(290);
    expect(reason.endsWith('...')).toBe(true);
  });

  it('keeps a message of exactly 300 characters whole', () => {
    const message = 'a'.repeat(300);

    expect(failureOneLiner({ weekId: '2026-W42', message })).toBe(
      `Weekly digest 2026-W42 failed: ${message}`,
    );
  });
});
