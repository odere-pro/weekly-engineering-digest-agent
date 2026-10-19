import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, SCHEDULE } from '../__fixtures__/initHarness';
import {
  defaultScheduleProgram,
  quoteIfSpaced,
  scheduleCommand,
  scheduleSection,
} from './schedule';

const CRON = '45 7 * * 1';

describe('scheduleSection', () => {
  it('prints where to save the rendered schedule, its content and the install hint', () => {
    const h = harness();

    const text = scheduleSection(h.io, '/work/digest.config.json', CRON);

    expect(text).toBe(
      `\nTo run the digest weekly, save this as ${SCHEDULE.path}:\n\n${SCHEDULE.content}\n${SCHEDULE.installHint}\n`,
    );
  });

  it('ends the content with a newline when the renderer left it off', () => {
    const h = harness();
    h.renderSchedule.mockReturnValue({ ...SCHEDULE, content: 'no newline' });

    const text = scheduleSection(h.io, '/work/digest.config.json', CRON);

    expect(text).toContain('no newline\n\n');
  });

  it('asks the renderer for the platform it runs on, the cron, the command and the folder', () => {
    const h = harness({ platform: 'darwin' });

    scheduleSection(h.io, '/work/digest.config.json', CRON);

    expect(h.renderSchedule).toHaveBeenCalledWith('darwin', {
      cron: CRON,
      command: '/usr/local/bin/digest run',
      workingDir: '/work',
    });
  });

  it('prints the reason, and the two ways to schedule by hand, when the renderer fails', () => {
    const h = harness();
    h.renderSchedule.mockImplementation(() => {
      throw new Error('renderOsSchedule failed');
    });

    const text = scheduleSection(h.io, '/work/digest.config.json', CRON);

    expect(text).toContain('No OS schedule snippet is available (renderOsSchedule failed).');
    expect(text).toContain('"digest run"');
    expect(text).toContain('"digest serve"');
  });

  it('prints the reason when the platform has no snippet', () => {
    const h = harness();
    h.renderSchedule.mockImplementation(() => {
      throw new Error('Unsupported platform: freebsd');
    });

    expect(scheduleSection(h.io, '/work/digest.config.json', CRON)).toContain(
      'No OS schedule snippet is available (Unsupported platform: freebsd).',
    );
  });
});

describe('scheduleCommand', () => {
  const commandFor = (configPath: string): string => scheduleCommand(harness().io, configPath);

  it('is the program and "run" for the config in the working directory', () => {
    expect(commandFor('digest.config.json')).toBe('/usr/local/bin/digest run');
  });

  it('does not repeat the default config when it is given as an absolute path', () => {
    expect(commandFor('/work/digest.config.json')).toBe('/usr/local/bin/digest run');
  });

  it('passes a config outside the working directory on, quoted when its path has spaces', () => {
    expect(commandFor('/srv/my configs/digest.json')).toBe(
      '/usr/local/bin/digest -c "/srv/my configs/digest.json" run',
    );
  });

  it('resolves a relative config path against the working directory', () => {
    expect(commandFor('conf/digest.json')).toBe(
      '/usr/local/bin/digest -c /work/conf/digest.json run',
    );
  });
});

describe('quoteIfSpaced', () => {
  it('leaves a part without whitespace alone', () => {
    expect(quoteIfSpaced('/usr/local/bin/digest')).toBe('/usr/local/bin/digest');
  });

  it.each(['/srv/my configs/a.json', 'a\tb'])('wraps %j in double quotes', (part) => {
    expect(quoteIfSpaced(part)).toBe(`"${part}"`);
  });
});

describe('defaultScheduleProgram', () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });

  it('is this node binary and the script, so a scheduler can start it from any folder', () => {
    process.argv = [process.execPath, '/opt/digest/cli.js'];

    expect(defaultScheduleProgram()).toBe(
      [process.execPath, '/opt/digest/cli.js'].map(quoteIfSpaced).join(' '),
    );
  });

  it('resolves a relative script path', () => {
    process.argv = [process.execPath, 'dist/cli.js'];

    expect(defaultScheduleProgram().endsWith(resolve('dist/cli.js'))).toBe(true);
  });

  it('quotes a script path with spaces', () => {
    process.argv = [process.execPath, '/opt/my digest/cli.js'];

    expect(defaultScheduleProgram().endsWith(' "/opt/my digest/cli.js"')).toBe(true);
  });

  it.each(['index.ts', 'index.tsx', 'index.mts', 'index.cts'])(
    'falls back to the installed digest command for the TypeScript entry %s (a dev run through tsx)',
    (script) => {
      process.argv = [process.execPath, `/repo/src/cli/${script}`];

      expect(defaultScheduleProgram()).toBe('digest');
    },
  );

  it('falls back to the installed digest command when there is no script', () => {
    process.argv = [process.execPath];

    expect(defaultScheduleProgram()).toBe('digest');
  });
});
