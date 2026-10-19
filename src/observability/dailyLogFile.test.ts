import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDailyLogFile } from './dailyLogFile';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'daily-log-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const logFile = (day: string): string => join(dataDir, 'logs', day, 'digest.log');

describe('createDailyLogFile', () => {
  it('appends each line to <dataDir>/logs/<day>/digest.log, creating the folders', async () => {
    const file = createDailyLogFile({
      dataDir,
      timeZone: 'UTC',
      now: () => new Date('2026-10-19T07:45:00Z'),
    });

    file.write('{"msg":"one"}\n');
    file.write('{"msg":"two"}\n');

    await expect(readFile(logFile('2026-10-19'), 'utf8')).resolves.toBe(
      '{"msg":"one"}\n{"msg":"two"}\n',
    );
  });

  it('starts the next day folder after midnight in the time zone', async () => {
    let now = new Date('2026-10-19T21:59:00Z');
    const file = createDailyLogFile({ dataDir, timeZone: 'Europe/Berlin', now: () => now });

    file.write('before\n');
    now = new Date('2026-10-19T22:01:00Z'); // 00:01 on 20 October in Berlin
    file.write('after\n');

    await expect(readFile(logFile('2026-10-19'), 'utf8')).resolves.toBe('before\n');
    await expect(readFile(logFile('2026-10-20'), 'utf8')).resolves.toBe('after\n');
  });

  it('makes the folder again, losing no line, when it was removed while the process runs', async () => {
    const onError = vi.fn<(error: unknown) => void>();
    const file = createDailyLogFile({
      dataDir,
      timeZone: 'UTC',
      now: () => new Date('2026-10-19T07:45:00Z'),
      onError,
    });

    file.write('one\n');
    await rm(join(dataDir, 'logs'), { recursive: true, force: true });
    file.write('two\n');

    await expect(readFile(logFile('2026-10-19'), 'utf8')).resolves.toBe('two\n');
    expect(onError).not.toHaveBeenCalled();
  });

  it('never throws for a time zone the system does not know', () => {
    const onError = vi.fn<(error: unknown) => void>();
    const file = createDailyLogFile({ dataDir, timeZone: 'Mars/Olympus', onError });

    expect(() => {
      file.write('one\n');
    }).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports a failed write once, then keeps trying without throwing', async () => {
    await writeFile(join(dataDir, 'logs'), 'a file where the logs folder should be');
    const onError = vi.fn<(error: unknown) => void>();
    const file = createDailyLogFile({
      dataDir,
      timeZone: 'UTC',
      now: () => new Date('2026-10-19T07:45:00Z'),
      onError,
    });

    expect(() => {
      file.write('one\n');
      file.write('two\n');
    }).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });
});
