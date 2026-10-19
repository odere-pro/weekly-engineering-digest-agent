import { describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/runDigest';
import { ExitCode } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { handOver } from './handOver';
import type { GiveUp, RetryWhere } from './types';

interface MockLogger extends Logger {
  warn: Mock<Logger['warn']>;
  error: Mock<Logger['error']>;
}

function mockLogger(): MockLogger {
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

const where: RetryWhere = { weekId: '2026-W42', trigger: 'schedule' };
const owed: RunResult = {
  record: makeRunRecord({ status: 'failed', error: { message: 'HTTP 503', step: 'deliver' } }),
  exitCode: ExitCode.Failed,
};

describe('handOver', () => {
  it('hands the owed result to onGiveUp, once, and says why', async () => {
    const logger = mockLogger();
    const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());

    await handOver({ onGiveUp, logger }, owed, where, 'the scheduler stopped');

    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', owed);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Sending the failure note held back for a retry that will not run',
      { weekId: '2026-W42', trigger: 'schedule', reason: 'the scheduler stopped' },
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('names the trigger of a catch-up run', async () => {
    const logger = mockLogger();

    await handOver(
      { onGiveUp: () => Promise.resolve(), logger },
      owed,
      { weekId: '2026-W42', trigger: 'catch-up' },
      'the run kept failing',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ trigger: 'catch-up' }),
    );
  });

  it('does nothing when no attempt held a note back', async () => {
    const logger = mockLogger();
    const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());

    await handOver({ onGiveUp, logger }, undefined, where, 'the run kept failing');

    expect(onGiveUp).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does nothing when the scheduler has no onGiveUp', async () => {
    const logger = mockLogger();

    await handOver({ logger }, owed, where, 'the run kept failing');

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a hook that rejects, and does not throw', async () => {
    const logger = mockLogger();
    const onGiveUp = vi.fn<GiveUp>(() => Promise.reject(new Error('Slack is down')));

    await expect(handOver({ onGiveUp, logger }, owed, where, 'x')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Could not send the failure note held back',
      { weekId: '2026-W42', trigger: 'schedule', error: 'Slack is down' },
    );
  });

  it('logs a hook that throws before it returns a promise, and does not throw', async () => {
    const logger = mockLogger();
    const onGiveUp = vi.fn<GiveUp>(() => {
      throw new Error('bad hook');
    });

    await expect(handOver({ onGiveUp, logger }, owed, where, 'x')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'Could not send the failure note held back',
      expect.objectContaining({ error: 'bad hook' }),
    );
  });
});
