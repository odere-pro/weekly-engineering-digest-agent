// `digest init` and the folder the digest files go to: the channels question, the summary, and the
// config that stays as it was. The folder itself is built in prompts/saveLocally.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../sources/defaultSources';
import {
  CONFIG_PATH,
  EMAIL_RULES,
  harness,
  SLACK_RULES,
  writtenConfig,
  type Harness,
  type HarnessOptions,
} from './__fixtures__/initHarness';
import { initCommand } from './init';
import type { InitCommandOptions } from './types';

const FOLDER = '/work/dist/2026-10-19/digest/';

async function run(
  options: HarnessOptions = {},
  command: InitCommandOptions = { config: CONFIG_PATH },
): Promise<Harness & { printed: string }> {
  const h = harness(options);
  const code = await initCommand(command, h.io);
  expect(code).toBe(0);
  return { ...h, printed: h.out.join('') };
}

const savedTo = (printed: string): string | undefined =>
  /^ {2}saved to: (.*) \(one folder per week\)$/m.exec(printed)?.[1];

describe('the folder in the output', () => {
  it('is printed with --yes: the Monday folder of this week below the data folder', async () => {
    const { printed } = await run({}, { yes: true, config: CONFIG_PATH });

    expect(printed).toContain(`  saved to: ${FOLDER} (one folder per week)\n`);
  });

  it('is printed after the interactive questions too', async () => {
    const { printed } = await run();

    expect(printed).toContain(`  saved to: ${FOLDER} (one folder per week)\n`);
  });

  it('is the folder the channels question showed', async () => {
    const { calls, printed } = await run({ rules: EMAIL_RULES });

    const label = calls.find((c) => /Deliver the digest/.test(c.message))?.options.choices?.[0]
      ?.name;
    expect(label).toBe(`Save locally (Markdown and HTML): ${savedTo(printed)}`);
  });

  it('is the folder digest runs from, which a scheduled run starts in, not the config file’s', async () => {
    const { printed, renderSchedule } = await run(
      { cwd: '/home/ana/digest' },
      { yes: true, config: '/etc/digest/digest.config.json' },
    );

    expect(savedTo(printed)).toBe('/home/ana/digest/dist/2026-10-19/digest/');
    expect(renderSchedule.mock.calls[0]?.[1].workingDir).toBe('/home/ana/digest');
  });

  it.each([
    ['Asia/Tokyo', '2026-10-19'],
    ['America/New_York', '2026-10-12'],
  ])('counts the week in the time zone of the schedule (%s)', async (timeZone, monday) => {
    const { printed } = await run(
      { now: '2026-10-18T23:30:00Z', timeZone },
      { yes: true, config: CONFIG_PATH },
    );

    expect(savedTo(printed)).toBe(`/work/dist/${monday}/digest/`);
  });

  it('is the ./dist folder on the host in Docker, in the question and in the summary', async () => {
    const { calls, printed } = await run({
      inDocker: true,
      cwd: '/app',
      env: { DIGEST_HOST_OS: 'darwin' },
    });

    const label = calls.find((c) => /Deliver the digest/.test(c.message))?.options.choices?.[0]
      ?.name;
    expect(label).toBe('Save locally (Markdown and HTML): ./dist/2026-10-19/digest/ on the host');
    expect(printed).toContain(
      '  saved to: ./dist/2026-10-19/digest/ on the host (one folder per week)\n',
    );
    expect(printed).not.toContain('/app/dist');
  });

  it('sits between the delivery channels and the schedule', async () => {
    const { printed } = await run({ rules: SLACK_RULES });

    const lines = printed.split('\n');
    const at = lines.findIndex((line) => line.startsWith('  delivery:'));
    expect(lines.slice(at, at + 3)).toEqual([
      '  delivery: markdown, slack',
      `  saved to: ${FOLDER} (one folder per week)`,
      '  schedule: Europe/Berlin',
    ]);
  });
});

describe('the config file', () => {
  const PLAIN = {
    profile: 'light',
    focusAreas: [...DEFAULT_FOCUS_AREAS],
    schedule: { timeZone: 'Europe/Berlin' },
    sources: [...DEFAULT_SOURCES],
  };

  it('is the same with --yes and with the questions answered by Enter: no dataDir, no delivery', async () => {
    const yes = await run({}, { yes: true, config: CONFIG_PATH });
    const asked = await run();

    expect(writtenConfig(yes)).toEqual(PLAIN);
    expect(writtenConfig(asked)).toEqual(PLAIN);
    expect(asked.files.get(CONFIG_PATH)?.content).toBe(yes.files.get(CONFIG_PATH)?.content);
  });

  it('gets no markdown section when email is added: the Markdown files need no setting', async () => {
    const h = await run({ rules: EMAIL_RULES });

    const delivery = writtenConfig(h)['delivery'] as Record<string, unknown>;
    expect(Object.keys(delivery)).toEqual(['email']);
    expect(h.files.get(CONFIG_PATH)?.content).not.toMatch(/markdown|dataDir/);
  });
});
