import { describe, expect, it, vi, type Mock } from 'vitest';
import type { RunStatus } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { fixedClock } from '../../../test/fakes';
import { catchUp, isUnsettled, SETTLED, type CatchUpSettings } from './catchUp';
import type { SlotSource } from './firstSlotOfWeek';

/** Wednesday 2026-10-14 12:00 in Berlin, week 42. This week's slot, Monday 07:45, has passed. */
const NOW = '2026-10-14T10:00:00Z';
const MONDAY_SLOT = '2026-10-12T05:45:00.000Z';
const NEXT_MONDAY_SLOT = '2026-10-19T05:45:00.000Z';

interface MockLogger extends Logger {
  debug: Mock<Logger['debug']>;
  info: Mock<Logger['info']>;
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

/** A cron with a fire on Mondays 07:45 Berlin time: the given slots, in order. */
function firesAt(...times: string[]): SlotSource {
  const slots = times.map((time) => new Date(time));
  return {
    nextRun: (from) => slots.find((slot) => slot.getTime() > (from?.getTime() ?? 0)) ?? null,
  };
}

function setup(
  status: RunStatus | undefined | Error,
  now = NOW,
): {
  settings: CatchUpSettings;
  logger: MockLogger;
  runStatus: Mock<CatchUpSettings['runStatus']>;
} {
  const logger = mockLogger();
  const runStatus = vi.fn<CatchUpSettings['runStatus']>(() =>
    status instanceof Error ? Promise.reject(status) : Promise.resolve(status),
  );
  const settings: CatchUpSettings = {
    timeZone: 'Europe/Berlin',
    clock: fixedClock(now),
    logger,
    runStatus,
  };
  return { settings, logger, runStatus };
}

describe('catchUp', () => {
  it('runs the current week now when its slot has passed and no run is saved', async () => {
    const { settings, logger, runStatus } = setup(undefined);
    const execute = vi.fn(() => Promise.resolve());

    await catchUp(firesAt(MONDAY_SLOT, NEXT_MONDAY_SLOT), settings, execute);

    expect(runStatus).toHaveBeenCalledWith('2026-W42');
    expect(execute).toHaveBeenCalledExactlyOnceWith('2026-W42', 'catch-up');
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('Catching up on a missed run', {
      weekId: '2026-W42',
      slot: MONDAY_SLOT,
    });
  });

  it.each<RunStatus>(['failed', 'dry-run', 'skipped'])(
    'runs the week again when the saved run ended %s',
    async (status) => {
      const { settings } = setup(status);
      const execute = vi.fn(() => Promise.resolve());

      await catchUp(firesAt(MONDAY_SLOT), settings, execute);

      expect(execute).toHaveBeenCalledExactlyOnceWith('2026-W42', 'catch-up');
    },
  );

  it.each<RunStatus>(['sent', 'quiet', 'blocked'])(
    'leaves a week alone that ended %s',
    async (status) => {
      const { settings, logger } = setup(status);
      const execute = vi.fn(() => Promise.resolve());

      await catchUp(firesAt(MONDAY_SLOT), settings, execute);

      expect(execute).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('No catch-up: the week has settled', {
        weekId: '2026-W42',
        status,
      });
    },
  );

  it('waits for the slot of this week when it is still ahead, without reading the store', async () => {
    const { settings, runStatus } = setup(undefined, '2026-10-12T05:44:59Z');
    const execute = vi.fn(() => Promise.resolve());

    await catchUp(firesAt(MONDAY_SLOT), settings, execute);

    expect(runStatus).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs at the very moment of the slot', async () => {
    const { settings } = setup(undefined, MONDAY_SLOT);
    const execute = vi.fn(() => Promise.resolve());

    await catchUp(firesAt(MONDAY_SLOT), settings, execute);

    expect(execute).toHaveBeenCalledExactlyOnceWith('2026-W42', 'catch-up');
  });

  it('does nothing when the cron never fires again', async () => {
    const { settings, runStatus } = setup(undefined);
    const execute = vi.fn(() => Promise.resolve());

    await catchUp(firesAt(), settings, execute);

    expect(runStatus).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('logs and skips when the run store cannot be read, and does not throw', async () => {
    const { settings, logger } = setup(new Error('disk gone'));
    const execute = vi.fn(() => Promise.resolve());

    await expect(catchUp(firesAt(MONDAY_SLOT), settings, execute)).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Missed-week catch-up skipped: could not read the run store',
      { weekId: '2026-W42', error: 'disk gone' },
    );
  });

  it('starts the run without waiting for it: the caller needs its handle at once', async () => {
    const { settings } = setup('failed');
    const execute = vi.fn(() => new Promise<void>(() => undefined));

    await catchUp(firesAt(MONDAY_SLOT), settings, execute);

    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('isUnsettled', () => {
  it('is true for a week with no saved run', async () => {
    const { settings } = setup(undefined);

    await expect(isUnsettled(settings, '2026-W42')).resolves.toBe(true);
  });

  it.each<RunStatus>(['failed', 'dry-run', 'skipped'])(
    'is true for a week that ended %s',
    async (status) => {
      const { settings } = setup(status);

      await expect(isUnsettled(settings, '2026-W42')).resolves.toBe(true);
    },
  );

  it.each<RunStatus>(['sent', 'quiet', 'blocked'])(
    'is false for a week that ended %s',
    async (status) => {
      const { settings } = setup(status);

      await expect(isUnsettled(settings, '2026-W42')).resolves.toBe(false);
    },
  );

  it('is false, with an error log, when the store fails', async () => {
    const { settings, logger } = setup(new Error('locked'));

    await expect(isUnsettled(settings, '2026-W42')).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not read'), {
      weekId: '2026-W42',
      error: 'locked',
    });
  });
});

describe('SETTLED', () => {
  it('holds exactly the endings a catch-up leaves alone', () => {
    expect([...SETTLED].sort()).toEqual(['blocked', 'quiet', 'sent']);
  });
});
