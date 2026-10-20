import { describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/types';
import { ExitCode } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { handOver } from './handOver';
import type { GiveUp, RetryWhere, SendNote } from './types';

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

describe('handOver with a note the scheduler composed', () => {
  const note = 'The run for 2026-W42 stopped before it saved a record (EIO).';

  it('sends it through onNoRecord, once, when no failed result was held back', async () => {
    const logger = mockLogger();
    const onNoRecord = vi.fn<SendNote>(() => Promise.resolve());

    await handOver({ onNoRecord, logger }, undefined, where, 'the run kept throwing', note);

    expect(onNoRecord).toHaveBeenCalledExactlyOnceWith('2026-W42', note);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Sending the failure note of a week that ended with no run record',
      { weekId: '2026-W42', trigger: 'schedule', reason: 'the run kept throwing' },
    );
  });

  it('sends the held failure note instead, never both', async () => {
    const logger = mockLogger();
    const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());
    const onNoRecord = vi.fn<SendNote>(() => Promise.resolve());

    await handOver({ onGiveUp, onNoRecord, logger }, owed, where, 'the run kept throwing', note);

    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', owed);
    expect(onNoRecord).not.toHaveBeenCalled();
  });

  it('does not fall back to the note when a held failure has no onGiveUp to go through', async () => {
    const logger = mockLogger();
    const onNoRecord = vi.fn<SendNote>(() => Promise.resolve());

    await handOver({ onNoRecord, logger }, owed, where, 'x', note);

    expect(onNoRecord).not.toHaveBeenCalled();
  });

  it('does nothing without a note, or without onNoRecord', async () => {
    const logger = mockLogger();
    const onNoRecord = vi.fn<SendNote>(() => Promise.resolve());

    await handOver({ onNoRecord, logger }, undefined, where, 'x');
    await handOver({ logger }, undefined, where, 'x', note);

    expect(onNoRecord).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a hook that rejects or throws, and does not throw', async () => {
    const logger = mockLogger();
    const rejects = vi.fn<SendNote>(() => Promise.reject(new Error('Slack is down')));
    const throws = vi.fn<SendNote>(() => {
      throw new Error('bad hook');
    });

    await expect(
      handOver({ onNoRecord: rejects, logger }, undefined, where, 'x', note),
    ).resolves.toBeUndefined();
    await expect(
      handOver({ onNoRecord: throws, logger }, undefined, where, 'x', note),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenNthCalledWith(1, 'Could not send the scheduler failure note', {
      weekId: '2026-W42',
      trigger: 'schedule',
      error: 'Slack is down',
    });
    expect(logger.error).toHaveBeenNthCalledWith(
      2,
      'Could not send the scheduler failure note',
      expect.objectContaining({ error: 'bad hook' }),
    );
  });
});
