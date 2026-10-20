import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from '../../shared/telemetry';
import { CapturingDelivery } from '../../../test/fakes';
import { sendSchedulerNote } from './sendSchedulerNote';

const WEEK = '2026-W42';
const MESSAGE = 'The run for 2026-W42 stopped before it saved a record (EIO).';

interface MockLogger extends Logger {
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

describe('sendSchedulerNote', () => {
  it("sends the week and the scheduler's text to every channel, with no step", async () => {
    const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('slack')];

    await sendSchedulerNote({ deliveries, logger: mockLogger() }, WEEK, MESSAGE);

    for (const delivery of deliveries) {
      expect(delivery.failures).toEqual([{ weekId: WEEK, message: MESSAGE }]);
    }
  });

  it('logs a channel that cannot take the note, and the others still get it', async () => {
    const deliveries = [new CapturingDelivery('email'), new CapturingDelivery('markdown')];
    const [email] = deliveries;
    if (email) email.sendFailure = () => Promise.reject(new Error('mail server is down'));
    const logger = mockLogger();

    await expect(sendSchedulerNote({ deliveries, logger }, WEEK, MESSAGE)).resolves.toBeUndefined();

    expect(deliveries[1]?.failures).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Could not send the failure note', {
      delivery: 'email',
      error: 'mail server is down',
    });
  });

  it('does nothing when no channel is configured', async () => {
    const logger = mockLogger();

    await expect(
      sendSchedulerNote({ deliveries: [], logger }, WEEK, MESSAGE),
    ).resolves.toBeUndefined();

    expect(logger.error).not.toHaveBeenCalled();
  });
});
