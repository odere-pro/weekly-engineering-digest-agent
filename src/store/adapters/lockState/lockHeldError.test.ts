import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../../domain/schemas';
import { DigestError } from '../../../shared/errors';
import { isLockHeldError, LOCK_HELD_MESSAGE } from '../../lockHeld';
import { lockHeldError } from './lockHeldError';

const NOW = '2026-01-05T08:00:00.000Z';

describe('lockHeldError', () => {
  it('names the pid, the host and the week of the run that holds the lock', () => {
    const error = lockHeldError({ pid: 4242, runId: '2026-W42', startedAt: NOW, hostname: 'box' });

    expect(error).toBeInstanceOf(DigestError);
    expect(error.message).toBe('Another run is in progress (pid 4242, host box, week 2026-W42)');
  });

  it('leaves the host out for a legacy lock that names none', () => {
    const error = lockHeldError({ pid: 4242, runId: '2026-W41', startedAt: NOW });

    expect(error.message).toBe('Another run is in progress (pid 4242, week 2026-W41)');
  });

  it('exits with the plain failure code', () => {
    const error = lockHeldError({ pid: 1, runId: '2026-W42', startedAt: NOW });

    expect(error.exitCode).toBe(ExitCode.Failed);
  });

  it('starts with the shared message text', () => {
    const error = lockHeldError({ pid: 1, runId: '2026-W42', startedAt: NOW });

    expect(error.message.startsWith(LOCK_HELD_MESSAGE)).toBe(true);
  });

  it('is recognised by isLockHeldError, which is how the scheduler tells it from a failure', () => {
    const error = lockHeldError({ pid: 4242, runId: '2026-W42', startedAt: NOW, hostname: 'box' });

    expect(isLockHeldError(error)).toBe(true);
  });
});
