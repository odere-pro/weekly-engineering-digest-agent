import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/core/schemas.js';
import { fixedClock, systemClock } from '../../src/shared/clock.js';
import { DigestError, NotImplementedError, errorMessage } from '../../src/shared/errors.js';
import { noopLogger, noopTracer } from '../../src/shared/telemetry.js';

describe('errors', () => {
  it('DigestError defaults to exit code 1 and keeps the step and cause', () => {
    const cause = new Error('root');
    const error = new DigestError('boom', { step: 'write', cause });
    expect(error.exitCode).toBe(ExitCode.Failed);
    expect(error.step).toBe('write');
    expect(error.cause).toBe(cause);
    expect(new DigestError('blocked', { exitCode: ExitCode.Blocked }).exitCode).toBe(2);
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
