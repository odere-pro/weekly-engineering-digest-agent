import { totalmem } from 'node:os';
import * as inquirer from '@inquirer/prompts';
import { describe, expect, it, vi } from 'vitest';
import { renderOsSchedule } from '../../../scheduler/osSchedule';
import { systemClock } from '../../../shared/clock';
import { CONFIG_PATH, harness, writtenEnv } from '../__fixtures__/initHarness';
import { initCommand } from '../init';
import { writeSecretFile } from '../envFile/secretFile';
import { defaultScheduleProgram } from '../schedule/schedule';
import { createDefaultIo } from './defaultIo';
import { inquirerPrompts } from './inquirerPrompts';
import { isEmptyFile, pathExists, readTextIfPresent, writeTextFile } from './files';

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

describe('createDefaultIo', () => {
  it('reads the machine init runs on', () => {
    const io = createDefaultIo();

    expect(io.env).toBe(process.env);
    expect(io.platform).toBe(process.platform);
    expect(io.totalMemoryBytes).toBe(totalmem());
    expect(io.memoryLimitBytes).toBe(process.constrainedMemory());
    expect(io.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(io.cwd).toBe(process.cwd());
  });

  it('tells the time with the system clock, which names the week folder it shows', () => {
    expect(createDefaultIo().clock).toBe(systemClock);
  });

  it('loads the secrets from ./.env, the file digest reads', () => {
    expect(createDefaultIo().envPath).toBe('.env');
  });

  it('plugs in the real prompts, scheduler, files and owner-only writer', () => {
    const io = createDefaultIo();

    expect(io.prompts).toBe(inquirerPrompts);
    expect(io.renderSchedule).toBe(renderOsSchedule);
    expect(io.scheduleProgram).toBe(defaultScheduleProgram());
    expect(io.exists).toBe(pathExists);
    expect(io.isEmptyFile).toBe(isEmptyFile);
    expect(io.readFile).toBe(readTextIfPresent);
    expect(io.writeFile).toBe(writeTextFile);
    expect(io.writeSecretFile).toBe(writeSecretFile);
  });

  it('prints to the process streams', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const io = createDefaultIo();

    io.stdout('to stdout');
    io.stderr('to stderr');

    expect(out).toHaveBeenCalledWith('to stdout');
    expect(err).toHaveBeenCalledWith('to stderr');
  });
});

describe('the default prompts', () => {
  it('drive @inquirer/prompts with the same questions', async () => {
    vi.mocked(inquirer.checkbox).mockImplementation((config) => {
      const choices = config.choices as readonly { value: string; checked?: boolean }[];
      return Promise.resolve(choices.filter((c) => c.checked).map((c) => c.value));
    });
    vi.mocked(inquirer.input).mockImplementation((config) => Promise.resolve(config.default ?? ''));
    vi.mocked(inquirer.select).mockImplementation((config) => Promise.resolve(config.default));
    vi.mocked(inquirer.confirm).mockResolvedValue(true);
    vi.mocked(inquirer.password).mockResolvedValue('from-the-prompt');
    const { prompts: _scripted, ...io } = harness().io;

    const code = await initCommand({ config: CONFIG_PATH }, io);

    expect(code).toBe(0);
    expect(inquirer.checkbox).toHaveBeenCalledTimes(2);
    expect(inquirer.select).toHaveBeenCalledOnce();
    expect(inquirer.input).toHaveBeenCalledTimes(2);
  });

  it('use inquirer for passwords and confirmations', async () => {
    vi.mocked(inquirer.checkbox).mockImplementation((config) =>
      Promise.resolve(
        config.message.startsWith('Deliver')
          ? ['markdown', 'email', 'slack']
          : ['AI models and tooling'],
      ),
    );
    vi.mocked(inquirer.input).mockImplementation((config) => {
      const answers: Record<string, string> = {
        'SMTP host': 'smtp.example.com',
        'SMTP user': 'digest@example.com',
        Recipients: 'ana@example.com',
      };
      const key = Object.keys(answers).find((k) => config.message.startsWith(k));
      return Promise.resolve(key ? (answers[key] as string) : (config.default ?? ''));
    });
    vi.mocked(inquirer.select).mockImplementation((config) => Promise.resolve(config.default));
    vi.mocked(inquirer.confirm).mockResolvedValue(true);
    vi.mocked(inquirer.password).mockImplementation((config) =>
      Promise.resolve(
        config.message.startsWith('Slack') ? 'https://hooks.slack.com/services/x' : 'pw',
      ),
    );
    const h = harness({ existing: [CONFIG_PATH] });
    const { prompts: _scripted, ...io } = h.io;

    const code = await initCommand({ config: CONFIG_PATH }, io);

    expect(code).toBe(0);
    expect(inquirer.confirm).toHaveBeenCalled();
    expect(inquirer.password).toHaveBeenCalledTimes(2);
    expect(writtenEnv(h)['SMTP_PASSWORD']).toBe('pw');
  });
});
