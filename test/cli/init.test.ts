import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initCommand,
  recommendProfile,
  resolveOllamaUrl,
  type InitIo,
  type InitPrompts,
} from '../../src/cli/init.js';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../src/config/defaultSources.js';
import { loadConfig } from '../../src/config/load.js';
import { ConfigSchema, SecretsSchema } from '../../src/config/schema.js';
import { NotImplementedError } from '../../src/shared/errors.js';

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

const GIB = 1024 ** 3;
const CONFIG_PATH = '/work/digest.config.json';
const ENV_PATH = '/work/.env';
const SCHEDULE = {
  path: '/etc/systemd/user/digest.timer',
  content: '[Timer]\nOnCalendar=Mon 07:45\n',
  installHint: 'systemctl --user enable --now digest.timer',
};

type PromptKind = 'confirm' | 'checkbox' | 'input' | 'select' | 'password';
type Validate = (value: string) => true | string;
interface PromptCall {
  kind: PromptKind;
  message: string;
  options: {
    default?: unknown;
    validate?: Validate;
    choices?: readonly { name: string; value: string; checked?: boolean }[];
  };
}
type Rule = readonly [RegExp, unknown];

/**
 * A scripted user. A prompt without a matching rule behaves like pressing Enter (the default,
 * or the pre-checked choices); an answer that fails the prompt's own validate() fails the test.
 */
function scriptedPrompts(rules: readonly Rule[] = []): {
  prompts: InitPrompts;
  calls: PromptCall[];
} {
  const calls: PromptCall[] = [];
  const answer = (
    kind: PromptKind,
    options: PromptCall['options'] & { message: string },
  ): unknown => {
    calls.push({ kind, message: options.message, options });
    const rule = rules.find(([pattern]) => pattern.test(options.message));
    const value = rule ? rule[1] : pressEnter(kind, options);
    if (typeof value === 'string' && options.validate) {
      const verdict = options.validate(value);
      if (verdict !== true) throw new Error(`"${options.message}" rejected "${value}": ${verdict}`);
    }
    return value;
  };
  const prompts = {
    confirm: (o: never) => Promise.resolve(answer('confirm', o)),
    checkbox: (o: never) => Promise.resolve(answer('checkbox', o)),
    input: (o: never) => Promise.resolve(answer('input', o)),
    select: (o: never) => Promise.resolve(answer('select', o)),
    password: (o: never) => Promise.resolve(answer('password', o)),
  } as unknown as InitPrompts;
  return { prompts, calls };
}

function pressEnter(
  kind: PromptKind,
  options: PromptCall['options'] & { message: string },
): unknown {
  switch (kind) {
    case 'checkbox':
      return (options.choices ?? []).filter((c) => c.checked).map((c) => c.value);
    case 'input':
      return typeof options.default === 'string' ? options.default : '';
    case 'password':
      throw new Error(`no answer scripted for "${options.message}"`);
    default:
      return options.default;
  }
}

interface Harness {
  io: Partial<InitIo>;
  files: Map<string, { content: string; secret: boolean }>;
  calls: PromptCall[];
  out: string[];
  err: string[];
  renderSchedule: ReturnType<typeof vi.fn<InitIo['renderSchedule']>>;
}

interface HarnessOptions {
  rules?: readonly Rule[];
  existing?: readonly string[];
  inDocker?: boolean;
  env?: Record<string, string>;
  ramGiB?: number;
  platform?: NodeJS.Platform;
  prompts?: InitPrompts;
}

function harness(options: HarnessOptions = {}): Harness {
  const files = new Map<string, { content: string; secret: boolean }>();
  const preexisting = new Set(options.existing ?? []);
  const scripted = scriptedPrompts(options.rules);
  const out: string[] = [];
  const err: string[] = [];
  const renderSchedule = vi.fn<InitIo['renderSchedule']>(() => SCHEDULE);
  const io: Partial<InitIo> = {
    prompts: options.prompts ?? scripted.prompts,
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    totalMemoryBytes: (options.ramGiB ?? 32) * GIB,
    cwd: '/work',
    envPath: ENV_PATH,
    scheduleProgram: '/usr/local/bin/digest',
    renderSchedule,
    exists: (path) =>
      Promise.resolve(
        preexisting.has(path) || files.has(path) || (path === '/.dockerenv' && !!options.inDocker),
      ),
    writeFile: (path, content) => {
      files.set(path, { content, secret: false });
      return Promise.resolve();
    },
    writeSecretFile: (path, content) => {
      files.set(path, { content, secret: true });
      return Promise.resolve();
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, files, calls: scripted.calls, out, err, renderSchedule };
}

function writtenConfig(h: Harness): Record<string, unknown> {
  const file = h.files.get(CONFIG_PATH);
  if (!file) throw new Error('digest.config.json was not written');
  return JSON.parse(file.content) as Record<string, unknown>;
}

function writtenEnv(h: Harness): Record<string, string | undefined> {
  const file = h.files.get(ENV_PATH);
  if (!file) throw new Error('.env was not written');
  return parseEnv(file.content);
}

const EMAIL_RULES: readonly Rule[] = [
  [/Also deliver/, ['email']],
  [/SMTP host/, 'smtp.example.com'],
  [/SMTP user/, 'digest@example.com'],
  [/Recipients/, 'ana@example.com, bo@example.com'],
  [/SMTP password/, 'smtp-secret'],
];
const SLACK_RULES: readonly Rule[] = [
  [/Also deliver/, ['slack']],
  [/Slack webhook/, 'https://hooks.slack.com/services/T000/B000/hook-secret'],
];

describe('recommendProfile', () => {
  it.each([
    [64, 'quality'],
    [32, 'quality'],
    [24, 'light'],
    [16, 'light'],
    [8, 'light'],
  ])('recommends for %i GiB of RAM: %s', (gib, expected) => {
    expect(recommendProfile(gib * GIB)).toBe(expected);
  });

  it('keeps the light profile just under 32 GiB', () => {
    expect(recommendProfile(32 * GIB - 1)).toBe('light');
  });
});

describe('resolveOllamaUrl', () => {
  it.each([
    [true, 'darwin', 'http://host.docker.internal:11434'],
    [true, 'linux', 'http://ollama:11434'],
    [true, undefined, 'http://ollama:11434'],
    [false, 'darwin', 'http://localhost:11434'],
    [false, undefined, 'http://localhost:11434'],
  ])('inDocker=%s hostOs=%s -> %s', (inDocker, hostOs, expected) => {
    expect(resolveOllamaUrl({ inDocker, hostOs })).toBe(expected);
  });
});

describe('initCommand --yes', () => {
  it('writes a config that parses and a secret .env, without asking anything', async () => {
    const h = harness();

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
    const config = writtenConfig(h);
    expect(ConfigSchema.safeParse(config).success).toBe(true);
    expect(config['focusAreas']).toEqual([...DEFAULT_FOCUS_AREAS]);
    expect(config['sources']).toEqual([...DEFAULT_SOURCES]);
    expect(config['delivery']).toBeUndefined();
    expect(h.files.get(CONFIG_PATH)?.secret).toBe(false);
    expect(h.files.get(ENV_PATH)?.secret).toBe(true);
    expect(writtenEnv(h)['OLLAMA_URL']).toBe('http://localhost:11434');
  });

  it.each([
    [32, 'quality'],
    [16, 'light'],
  ])('picks the profile recommended for %i GiB: %s', async (ramGiB, profile) => {
    const h = harness({ ramGiB });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['profile']).toBe(profile);
  });

  it('refuses to overwrite an existing config', async () => {
    const h = harness({ existing: [CONFIG_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(CONFIG_PATH);
  });

  it('refuses to overwrite an existing .env', async () => {
    const h = harness({ existing: [ENV_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(ENV_PATH);
  });

  it('uses digest.config.json in the working directory by default', async () => {
    const h = harness();

    await initCommand({ yes: true }, h.io);

    expect([...h.files.keys()]).toContain('digest.config.json');
  });
});

describe('overwrite confirmation', () => {
  it('asks first, naming the existing files, and stops on no', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, false]] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.options.default).toBe(false);
    expect(h.calls[0]?.message).toContain(CONFIG_PATH);
    expect(h.calls[0]?.message).toContain(ENV_PATH);
  });

  it('defaults to keeping the files', async () => {
    const h = harness({ existing: [CONFIG_PATH] });

    expect(await initCommand({ config: CONFIG_PATH }, h.io)).toBe(1);
    expect(h.files.size).toBe(0);
  });

  it('overwrites after a yes', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, true]] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.files.has(CONFIG_PATH)).toBe(true);
    expect(h.files.has(ENV_PATH)).toBe(true);
  });

  it('does not ask when nothing exists', async () => {
    const h = harness();

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(h.calls.some((c) => c.kind === 'confirm' && /Overwrite/.test(c.message))).toBe(false);
  });
});

describe('OLLAMA_URL by mode', () => {
  it.each([
    ['plain host', { inDocker: false, env: {} }, 'http://localhost:11434'],
    [
      'plain host that sets DIGEST_HOST_OS',
      { inDocker: false, env: { DIGEST_HOST_OS: 'darwin' } },
      'http://localhost:11434',
    ],
    [
      'Docker on a Mac',
      { inDocker: true, env: { DIGEST_HOST_OS: 'darwin' } },
      'http://host.docker.internal:11434',
    ],
    [
      'Docker on Linux',
      { inDocker: true, env: { DIGEST_HOST_OS: 'linux' } },
      'http://ollama:11434',
    ],
    ['Docker, host OS unknown', { inDocker: true, env: {} }, 'http://ollama:11434'],
  ])('%s', async (_name, options, expected) => {
    const h = harness(options);

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)['OLLAMA_URL']).toBe(expected);
  });
});

describe('interactive answers', () => {
  it('writes Markdown only when no extra channel is picked', async () => {
    const h = harness();

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(writtenConfig(h)['delivery']).toBeUndefined();
    expect(Object.keys(writtenEnv(h)).sort()).toEqual(['OLLAMA_URL']);
  });

  it('puts the email fields in the config and the SMTP password in .env only', async () => {
    const h = harness({ rules: EMAIL_RULES });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(writtenConfig(h)['delivery']).toEqual({
      email: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTLS: true,
        user: 'digest@example.com',
        from: 'digest@example.com',
        to: ['ana@example.com', 'bo@example.com'],
      },
    });
    expect(writtenEnv(h)['SMTP_PASSWORD']).toBe('smtp-secret');
    expect(writtenEnv(h)['SLACK_WEBHOOK_URL']).toBeUndefined();
    expect(h.files.get(CONFIG_PATH)?.content).not.toContain('smtp-secret');
  });

  it('puts only the enabled flag in the config and the Slack webhook in .env', async () => {
    const h = harness({ rules: SLACK_RULES });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['delivery']).toEqual({ slack: { enabled: true } });
    expect(writtenEnv(h)['SLACK_WEBHOOK_URL']).toBe(
      'https://hooks.slack.com/services/T000/B000/hook-secret',
    );
    expect(writtenEnv(h)['SMTP_PASSWORD']).toBeUndefined();
    expect(h.files.get(CONFIG_PATH)?.content).not.toContain('hook-secret');
  });

  it('supports email and Slack together', async () => {
    const h = harness({
      rules: [
        [/Also deliver/, ['email', 'slack']],
        ...EMAIL_RULES.slice(1),
        ...SLACK_RULES.slice(1),
      ],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const delivery = writtenConfig(h)['delivery'] as Record<string, unknown>;
    expect(Object.keys(delivery).sort()).toEqual(['email', 'slack']);
    expect(Object.keys(writtenEnv(h)).sort()).toEqual([
      'OLLAMA_URL',
      'SLACK_WEBHOOK_URL',
      'SMTP_PASSWORD',
    ]);
  });

  it('turns on implicit TLS by default for port 465 and uses the typed sender', async () => {
    const h = harness({
      rules: [[/SMTP port/, '465'], [/From address/, 'noreply@corp.test'], ...EMAIL_RULES],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const delivery = writtenConfig(h)['delivery'] as { email: Record<string, unknown> };
    expect(delivery.email).toMatchObject({ port: 465, secure: true, from: 'noreply@corp.test' });
  });

  it('keeps secrets with special characters intact in .env', async () => {
    const passwords = ['pa ss#word', `it's "quoted"`, 'back\\nslash', 'x=y $HOME `cmd`'];
    for (const password of passwords) {
      const h = harness({ rules: [[/SMTP password/, password], ...EMAIL_RULES] });

      await initCommand({ config: CONFIG_PATH }, h.io);

      expect(writtenEnv(h)['SMTP_PASSWORD']).toBe(password);
    }
  });

  it('fails cleanly when a secret cannot be stored in .env', async () => {
    const h = harness({ rules: [[/SMTP password/, `a'b"c\`d`], ...EMAIL_RULES] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain('SMTP_PASSWORD');
    expect(h.err.join('')).not.toContain(`a'b"c\`d`);
  });

  it('merges ticked and typed focus areas without duplicates', async () => {
    const h = harness({
      rules: [
        [/^Focus areas/, ['AI models and tooling']],
        [/Other focus areas/, ' Kubernetes ,ai models and tooling,, Observability '],
      ],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['focusAreas']).toEqual([
      'AI models and tooling',
      'Kubernetes',
      'Observability',
    ]);
  });

  it('offers the default focus areas pre-ticked', async () => {
    const h = harness();

    await initCommand({ config: CONFIG_PATH }, h.io);

    const call = h.calls.find((c) => c.kind === 'checkbox' && /^Focus areas/.test(c.message));
    expect(call?.options.choices?.map((c) => [c.value, c.checked])).toEqual(
      DEFAULT_FOCUS_AREAS.map((area) => [area, true]),
    );
  });

  it('rejects an empty or oversized focus area list in the free-text prompt', async () => {
    async function freeTextValidator(picked: string[]): Promise<Validate> {
      const h = harness({
        rules: [
          [/^Focus areas/, picked],
          [/Other focus areas/, 'Kubernetes'],
        ],
      });
      await initCommand({ config: CONFIG_PATH }, h.io);
      const validate = h.calls.find((c) => /Other focus areas/.test(c.message))?.options.validate;
      if (!validate) throw new Error('the free-text prompt has no validate');
      return validate;
    }
    const tooMany = Array.from({ length: 25 }, (_, i) => `area ${String(i)}`).join(',');

    const nothingPicked = await freeTextValidator([]);
    const onePicked = await freeTextValidator(['one']);

    expect(nothingPicked('')).not.toBe(true);
    expect(nothingPicked('Kubernetes')).toBe(true);
    expect(onePicked('')).toBe(true);
    expect(onePicked(tooMany)).not.toBe(true);
    expect(onePicked('ONE')).toBe(true);
  });

  it.each([
    [32, 'quality'],
    [16, 'light'],
  ])('offers the recommended profile for %i GiB as the default: %s', async (ramGiB, profile) => {
    const h = harness({ ramGiB });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const call = h.calls.find((c) => c.kind === 'select');
    expect(call?.options.default).toBe(profile);
    expect(call?.options.choices?.map((c) => c.value)).toEqual(['quality', 'fast', 'light']);
    expect(call?.options.choices?.find((c) => c.value === profile)?.name).toContain('recommended');
    expect(writtenConfig(h)['profile']).toBe(profile);
  });

  it('writes the profile that was chosen', async () => {
    const h = harness({ rules: [[/Model profile/, 'fast']] });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['profile']).toBe('fast');
  });

  it('validates the email and webhook answers as they are typed', async () => {
    const h = harness({
      rules: [[/Also deliver/, ['email', 'slack']], ...EMAIL_RULES, ...SLACK_RULES.slice(1)],
    });
    await initCommand({ config: CONFIG_PATH }, h.io);
    const validator = (pattern: RegExp): Validate => {
      const validate = h.calls.find((c) => pattern.test(c.message))?.options.validate;
      if (!validate) throw new Error(`no validate for ${String(pattern)}`);
      return validate;
    };

    expect(validator(/SMTP host/)('')).not.toBe(true);
    expect(validator(/SMTP port/)('0')).not.toBe(true);
    expect(validator(/SMTP port/)('70000')).not.toBe(true);
    expect(validator(/SMTP port/)('25.5')).not.toBe(true);
    expect(validator(/SMTP port/)('2525')).toBe(true);
    expect(validator(/SMTP user/)('')).not.toBe(true);
    expect(validator(/Recipients/)('')).not.toBe(true);
    expect(validator(/Recipients/)('ana@example.com, nope')).not.toBe(true);
    expect(validator(/Recipients/)('ana@example.com')).toBe(true);
    expect(validator(/SMTP password/)('')).not.toBe(true);
    expect(validator(/Slack webhook/)('not a url')).not.toBe(true);
    expect(validator(/Slack webhook/)('http://hooks.slack.com/x')).not.toBe(true);
    expect(validator(/Slack webhook/)('https://hooks.slack.com/x')).toBe(true);
    expect(validator(/From address/)('nope')).not.toBe(true);
  });

  it('stops without writing when the user cancels with Ctrl+C', async () => {
    const cancel = (): Promise<never> =>
      Promise.reject(
        Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' }),
      );
    const prompts: InitPrompts = {
      confirm: cancel,
      checkbox: cancel,
      input: cancel,
      select: cancel,
      password: cancel,
    };
    const h = harness({ prompts });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toMatch(/cancel/i);
  });

  it('rethrows unexpected prompt failures', async () => {
    const boom = (): Promise<never> => Promise.reject(new Error('tty exploded'));
    const prompts: InitPrompts = {
      confirm: boom,
      checkbox: boom,
      input: boom,
      select: boom,
      password: boom,
    };
    const h = harness({ prompts });

    await expect(initCommand({ config: CONFIG_PATH }, h.io)).rejects.toThrow('tty exploded');
  });

  it('refuses a config that fails validation and writes nothing', async () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `area ${String(i)}`);
    const h = harness({ rules: [[/^Focus areas/, tooMany]] });
    // The scripted user bypasses validate(), as a buggy prompt could.
    const loose = h.io.prompts as InitPrompts;
    h.io.prompts = { ...loose, input: () => Promise.resolve('') };

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain('focusAreas');
  });
});

describe('write failures', () => {
  it('reports the file that could not be written and returns 1', async () => {
    const h = harness();
    h.io.writeFile = () => Promise.reject(new Error('EACCES: permission denied'));

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain(CONFIG_PATH);
    expect(h.err.join('')).toContain('EACCES');
  });

  it('reports a .env that could not be written', async () => {
    const h = harness();
    h.io.writeSecretFile = () => Promise.reject(new Error('EROFS: read-only file system'));

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain(ENV_PATH);
  });
});

describe('OS schedule snippet', () => {
  it('prints the rendered schedule outside Docker', async () => {
    const h = harness({ platform: 'linux' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.renderSchedule).toHaveBeenCalledWith('linux', {
      cron: '45 7 * * 1',
      command: '/usr/local/bin/digest run',
      workingDir: '/work',
    });
    const printed = h.out.join('');
    expect(printed).toContain(SCHEDULE.path);
    expect(printed).toContain(SCHEDULE.content);
    expect(printed).toContain(SCHEDULE.installHint);
  });

  it('passes a config outside the working directory on to the scheduled command', async () => {
    const h = harness();

    await initCommand({ yes: true, config: '/srv/my configs/digest.json' }, h.io);

    expect(h.renderSchedule.mock.calls[0]?.[1].command).toBe(
      '/usr/local/bin/digest -c "/srv/my configs/digest.json" run',
    );
  });

  it('resolves a relative config path against the working directory', async () => {
    const h = harness();

    await initCommand({ yes: true, config: 'conf/digest.json' }, h.io);

    expect(h.renderSchedule.mock.calls[0]?.[1].command).toBe(
      '/usr/local/bin/digest -c /work/conf/digest.json run',
    );
  });

  it('uses the platform it runs on', async () => {
    const h = harness({ platform: 'darwin' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.renderSchedule.mock.calls[0]?.[0]).toBe('darwin');
  });

  it('skips the snippet inside Docker, where the compose service schedules the run', async () => {
    const h = harness({ inDocker: true });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.renderSchedule).not.toHaveBeenCalled();
    expect(h.out.join('')).not.toContain(SCHEDULE.path);
  });

  it('prints a hint, and still succeeds, while renderOsSchedule is not implemented', async () => {
    const h = harness();
    h.renderSchedule.mockImplementation(() => {
      throw new NotImplementedError('W1-16');
    });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.out.join('')).toContain('digest run');
    expect(h.out.join('')).toContain('digest serve');
  });

  it('prints the reason, and still succeeds, when the platform has no snippet', async () => {
    const h = harness();
    h.renderSchedule.mockImplementation(() => {
      throw new Error('Unsupported platform: freebsd');
    });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.out.join('')).toContain('Unsupported platform: freebsd');
  });
});

describe('output', () => {
  it('lists what was written and never prints a secret', async () => {
    const h = harness({
      rules: [[/Also deliver/, ['email', 'slack']], ...EMAIL_RULES, ...SLACK_RULES.slice(1)],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const printed = h.out.join('') + h.err.join('');
    expect(printed).toContain(CONFIG_PATH);
    expect(printed).toContain(ENV_PATH);
    expect(printed).not.toContain('smtp-secret');
    expect(printed).not.toContain('hook-secret');
  });
});

describe('with the real file system', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function realIo(overrides: Partial<InitIo> = {}): Partial<InitIo> {
    const noise: string[] = [];
    return {
      prompts: scriptedPrompts().prompts,
      env: {},
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      cwd: dir,
      envPath: join(dir, '.env'),
      renderSchedule: () => SCHEDULE,
      stdout: (text) => noise.push(text),
      stderr: (text) => noise.push(text),
      ...overrides,
    };
  }

  it('writes a config that the loader accepts and an owner-only .env', async () => {
    const configPath = join(dir, 'digest.config.json');

    const code = await initCommand({ yes: true, config: configPath }, realIo());

    expect(code).toBe(0);
    const loaded = await loadConfig({ configPath, envPath: join(dir, '.env'), processEnv: {} });
    expect(loaded.config.focusAreas).toEqual([...DEFAULT_FOCUS_AREAS]);
    expect(loaded.env.OLLAMA_URL).toBe('http://localhost:11434');
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['.env', 'digest.config.json']);
  });

  it('stores the secrets so that the loader reads them back', async () => {
    const configPath = join(dir, 'digest.config.json');
    const rules: Rule[] = [
      [/SMTP password/, 'pa ss#word'],
      [/Also deliver/, ['email', 'slack']],
      ...EMAIL_RULES,
      ...SLACK_RULES.slice(1),
    ];

    await initCommand({ config: configPath }, realIo({ prompts: scriptedPrompts(rules).prompts }));

    const loaded = await loadConfig({ configPath, envPath: join(dir, '.env'), processEnv: {} });
    expect(SecretsSchema.parse(loaded.secrets)).toEqual({
      SMTP_PASSWORD: 'pa ss#word',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/hook-secret',
    });
    expect(loaded.config.delivery.email?.to).toEqual(['ana@example.com', 'bo@example.com']);
  });

  it('tightens an existing world-readable .env when overwriting it', async () => {
    const configPath = join(dir, 'digest.config.json');
    await writeFile(join(dir, '.env'), 'SMTP_PASSWORD=old\n', { mode: 0o644 });

    const code = await initCommand(
      { config: configPath },
      realIo({ prompts: scriptedPrompts([[/Overwrite/, true]]).prompts }),
    );

    expect(code).toBe(0);
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, '.env'), 'utf8')).not.toContain('old');
  });

  it('refuses to overwrite files on disk with --yes', async () => {
    const configPath = join(dir, 'digest.config.json');
    await writeFile(configPath, '{"keep":true}');

    const code = await initCommand({ yes: true, config: configPath }, realIo());

    expect(code).toBe(1);
    expect(await readFile(configPath, 'utf8')).toBe('{"keep":true}');
  });

  it('creates the config folder when it does not exist yet', async () => {
    const configPath = join(dir, 'conf', 'digest.config.json');

    const code = await initCommand({ yes: true, config: configPath }, realIo());

    expect(code).toBe(0);
    expect(await readdir(join(dir, 'conf'))).toEqual(['digest.config.json']);
  });

  it('leaves no temp file behind when the destination cannot be written', async () => {
    await mkdir(join(dir, '.env'));
    const configPath = join(dir, 'digest.config.json');

    const code = await initCommand(
      { config: configPath },
      realIo({ prompts: scriptedPrompts([[/Overwrite/, true]]).prompts }),
    );

    expect(code).toBe(1);
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

describe('the default prompts', () => {
  it('drive @inquirer/prompts with the same questions', async () => {
    const inquirer = await import('@inquirer/prompts');
    vi.mocked(inquirer.checkbox).mockImplementation((config) => {
      const choices = config.choices as readonly { value: string; checked?: boolean }[];
      return Promise.resolve(choices.filter((c) => c.checked).map((c) => c.value));
    });
    vi.mocked(inquirer.input).mockImplementation((config) => Promise.resolve(config.default ?? ''));
    vi.mocked(inquirer.select).mockImplementation((config) => Promise.resolve(config.default));
    vi.mocked(inquirer.confirm).mockResolvedValue(true);
    vi.mocked(inquirer.password).mockResolvedValue('from-the-prompt');
    const h = harness();
    delete h.io.prompts;

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(inquirer.checkbox).toHaveBeenCalledTimes(2);
    expect(inquirer.select).toHaveBeenCalledOnce();
    expect(inquirer.input).toHaveBeenCalledOnce();
  });

  it('use inquirer for passwords and confirmations', async () => {
    const inquirer = await import('@inquirer/prompts');
    vi.mocked(inquirer.checkbox).mockImplementation((config) =>
      Promise.resolve(
        config.message.startsWith('Also') ? ['email', 'slack'] : ['AI models and tooling'],
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
    delete h.io.prompts;

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(inquirer.confirm).toHaveBeenCalled();
    expect(inquirer.password).toHaveBeenCalledTimes(2);
    expect(writtenEnv(h)['SMTP_PASSWORD']).toBe('pw');
  });
});
