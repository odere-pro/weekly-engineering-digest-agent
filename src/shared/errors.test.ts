import { describe, expect, it } from 'vitest';
import { ExitCode } from '../domain/schemas';
import { fixedClock, systemClock } from './clock';
import { DigestError, FetchError, NotImplementedError, errorMessage } from './errors';
import { noopLogger, noopTracer } from './telemetry';

describe('errors', () => {
  it('DigestError defaults to exit code 1 and keeps the step and cause', () => {
    const cause = new Error('root');
    const error = new DigestError('boom', { step: 'write', cause });
    expect(error.exitCode).toBe(ExitCode.Failed);
    expect(error.step).toBe('write');
    expect(error.cause).toBe(cause);
    expect(new DigestError('blocked', { exitCode: ExitCode.Blocked }).exitCode).toBe(2);
  });

  describe('FetchError', () => {
    it('is a DigestError that carries the HTTP status and whether a retry may help', () => {
      const cause = new Error('socket hang up');
      const error = new FetchError('feed answered HTTP 503', {
        status: 503,
        retryable: true,
        cause,
      });
      expect(error).toBeInstanceOf(DigestError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('FetchError');
      expect(error.message).toBe('feed answered HTTP 503');
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
      expect(error.cause).toBe(cause);
      expect(error.exitCode).toBe(ExitCode.Failed);
    });

    it('has no status for a failure without a response', () => {
      const error = new FetchError('fetch failed', { retryable: true });
      expect(error.status).toBeUndefined();
      expect(error.retryable).toBe(true);
    });

    it('marks a permanent failure as not retryable and keeps the DigestError options', () => {
      const error = new FetchError('HTTP 404', {
        status: 404,
        retryable: false,
        step: 'collect',
        exitCode: ExitCode.Blocked,
      });
      expect(error.retryable).toBe(false);
      expect(error.step).toBe('collect');
      expect(error.exitCode).toBe(ExitCode.Blocked);
    });
  });

  it('NotImplementedError names the issue', () => {
    expect(new NotImplementedError('W1-01').message).toContain('W1-01');
  });

  it('errorMessage handles non-errors', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
  });
});

describe('clock and telemetry', () => {
  it('fixedClock always returns the same instant', () => {
    const clock = fixedClock('2026-10-16T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(clock.now()).not.toBe(clock.now());
    expect(systemClock.now()).toBeInstanceOf(Date);
  });

  it('no-op logger and tracer do nothing but run the function', async () => {
    noopLogger.info('x');
    noopLogger.child({ a: 1 }).error('y');
    await expect(noopTracer.span('s', {}, () => Promise.resolve(7))).resolves.toBe(7);
  });
});
