import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Fs from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasQualityMemory,
  initCommand,
  recommendProfile,
  resolveOllamaUrl,
  type InitIo,
  type InitPrompts,
} from './init';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../sources/defaultSources';
import { loadConfig } from '../../config/load';
import { ConfigSchema, SecretsSchema } from '../../config/schema';
import { NotImplementedError } from '../../shared/errors';

// Real files, except that a test can make rename or chmod fail like a bind mount does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, rename: vi.fn(actual.rename), chmod: vi.fn(actual.chmod) };
});

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
    choices?: readonly { name: string; value: string; checked?: boolean; description?: string }[];
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
  /** Files that exist with no content, like the ones `make docker-init` creates. */
  empty?: readonly string[];
  /** The zone this process runs in. */
  timeZone?: string;
  inDocker?: boolean;
  env?: Record<string, string>;
  ramGiB?: number;
  /** Bytes the container is limited to; 0 or unset when it has no limit. */
  memoryLimitGiB?: number;
  platform?: NodeJS.Platform;
  prompts?: InitPrompts;
  /** The text of an .env that already exists. */
  envText?: string;
  /** Makes reading the existing .env fail. */
  envReadError?: Error;
}

function harness(options: HarnessOptions = {}): Harness {
  const files = new Map<string, { content: string; secret: boolean }>();
  const emptyFiles = new Set(options.empty ?? []);
  const preexisting = new Set([
    ...(options.existing ?? []),
    ...(options.envText === undefined ? [] : [ENV_PATH]),
    ...emptyFiles,
  ]);
  const scripted = scriptedPrompts(options.rules);
  const out: string[] = [];
  const err: string[] = [];
  const renderSchedule = vi.fn<InitIo['renderSchedule']>(() => SCHEDULE);
  const io: Partial<InitIo> = {
    prompts: options.prompts ?? scripted.prompts,
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    totalMemoryBytes: (options.ramGiB ?? 32) * GIB,
    memoryLimitBytes: (options.memoryLimitGiB ?? 0) * GIB,
    timeZone: options.timeZone ?? 'Europe/Berlin',
    cwd: '/work',
    envPath: ENV_PATH,
    scheduleProgram: '/usr/local/bin/digest',
    renderSchedule,
    exists: (path) =>
      Promise.resolve(
        preexisting.has(path) || files.has(path) || (path === '/.dockerenv' && !!options.inDocker),
      ),
    isEmptyFile: (path) => Promise.resolve(emptyFiles.has(path) && !files.has(path)),
    readFile: (path) => {
      if (path === ENV_PATH && options.envReadError) return Promise.reject(options.envReadError);
      const written = files.get(path);
      if (written) return Promise.resolve(written.content);
      if (path === ENV_PATH && options.envText !== undefined)
        return Promise.resolve(options.envText);
      return Promise.resolve(preexisting.has(path) ? '' : undefined);
    },
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

function writtenEnvText(h: Harness): string {
  const file = h.files.get(ENV_PATH);
  if (!file) throw new Error('.env was not written');
  return file.content;
}

function writtenEnv(h: Harness): Record<string, string | undefined> {
  return parseEnv(writtenEnvText(h));
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
  it('recommends light, since quality has no measured baseline yet', () => {
    expect(recommendProfile()).toBe('light');
  });
});

describe('hasQualityMemory', () => {
  it.each([
    [64, true],
    [32, true],
    [31.3, true],
    [30.4, true],
    [30.3, false],
    [24, false],
    [16, false],
  ])('%d GiB: %s', (gib, expected) => {
    expect(hasQualityMemory(gib * GIB)).toBe(expected);
  });

  it('allows 5% under 32 GiB, for the memory a kernel keeps for itself', () => {
    expect(hasQualityMemory(32 * GIB * 0.95)).toBe(true);
    expect(hasQualityMemory(32 * GIB * 0.95 - 1)).toBe(false);
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

  it.each([64, 32, 16, 8])(
    'picks light whatever the RAM (%i GiB): quality is not measured yet',
    async (ramGiB) => {
      const h = harness({ ramGiB });

      await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

      expect(writtenConfig(h)['profile']).toBe('light');
    },
  );

  it('refuses to overwrite an existing config', async () => {
    const h = harness({ existing: [CONFIG_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(CONFIG_PATH);
  });

  it('merges into an existing .env instead of refusing, and keeps what it does not manage', async () => {
    const h = harness({ envText: 'GITHUB_TOKEN=ghp_keep\nLOG_LEVEL=debug\n' });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.err).toEqual([]);
    expect(writtenEnv(h)).toMatchObject({
      GITHUB_TOKEN: 'ghp_keep',
      LOG_LEVEL: 'debug',
      OLLAMA_URL: 'http://localhost:11434',
    });
  });

  it('uses digest.config.json in the working directory by default', async () => {
    const h = harness();

    await initCommand({ yes: true }, h.io);

    expect([...h.files.keys()]).toContain('digest.config.json');
  });
});

describe('overwrite confirmation', () => {
  it('asks first, naming the existing config, and stops on no', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, false]] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.options.default).toBe(false);
    expect(h.calls[0]?.message).toContain(CONFIG_PATH);
  });

  it('does not ask about .env: it is merged, not replaced', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, true]] });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const questions = h.calls.filter((c) => /Overwrite/.test(c.message));
    expect(questions).toHaveLength(1);
    expect(questions[0]?.message).not.toContain(ENV_PATH);
  });

  it('defaults to keeping the files', async () => {
    const h = harness({ existing: [CONFIG_PATH] });

    expect(await initCommand({ config: CONFIG_PATH }, h.io)).toBe(1);
    expect(h.files.size).toBe(0);
  });

  it('overwrites the config after a yes and updates .env', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, true]] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.files.has(CONFIG_PATH)).toBe(true);
    expect(h.files.has(ENV_PATH)).toBe(true);
  });

  it('does not ask when only .env exists', async () => {
    const h = harness({ envText: 'LOG_LEVEL=debug\n' });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.calls.some((c) => c.kind === 'confirm')).toBe(false);
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
    [
      'Docker on a Mac, as `uname -s` spells it',
      { inDocker: true, env: { DIGEST_HOST_OS: 'Darwin' } },
      'http://host.docker.internal:11434',
    ],
    [
      'Docker, host OS blank',
      { inDocker: true, env: { DIGEST_HOST_OS: '' } },
      'http://ollama:11434',
    ],
    [
      'a plain host with an unreadable DIGEST_HOST_OS',
      { inDocker: false, env: { DIGEST_HOST_OS: 'plan9' } },
      'http://localhost:11434',
    ],
  ])('%s', async (_name, options, expected) => {
    const h = harness(options);

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)['OLLAMA_URL']).toBe(expected);
  });
});

describe('an unreadable DIGEST_HOST_OS in Docker', () => {
  it('stops before asking anything, and names the variable', async () => {
    const h = harness({ inDocker: true, env: { DIGEST_HOST_OS: 'plan9' } });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain('DIGEST_HOST_OS');
    expect(h.calls).toEqual([]);
    expect(h.files.size).toBe(0);
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

  it.each([64, 32, 16])(
    'offers light as the recommended default, whatever the RAM (%i GiB)',
    async (ramGiB) => {
      const h = harness({ ramGiB });

      await initCommand({ config: CONFIG_PATH }, h.io);

      const call = h.calls.find((c) => c.kind === 'select');
      expect(call?.options.default).toBe('light');
      expect(call?.options.choices?.map((c) => c.value)).toEqual(['quality', 'fast', 'light']);
      const recommended = call?.options.choices?.filter((c) => c.name.includes('recommended'));
      expect(recommended?.map((c) => c.value)).toEqual(['light']);
      expect(writtenConfig(h)['profile']).toBe('light');
    },
  );

  it('writes the profile that was chosen', async () => {
    const h = harness({ rules: [[/Model profile/, 'fast']] });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['profile']).toBe('fast');
  });

  describe('what the profile question says about quality', () => {
    const descriptionOf = async (
      options: Parameters<typeof harness>[0],
      profile = 'quality',
    ): Promise<string> => {
      const h = harness(options);
      await initCommand({ config: CONFIG_PATH }, h.io);
      const call = h.calls.find((c) => c.kind === 'select');
      return call?.options.choices?.find((c) => c.value === profile)?.description ?? '';
    };

    it('says it is not measured yet and took about 1 h per run on the reference laptop', async () => {
      const text = await descriptionOf({ ramGiB: 64 });

      expect(text).toMatch(/not measured yet/);
      expect(text).toMatch(/about 1 h/);
      expect(text).toMatch(/reference laptop/);
      expect(text).toMatch(/32 GB/);
    });

    it('does not mention memory when the machine has enough', async () => {
      expect(await descriptionOf({ ramGiB: 32 })).not.toMatch(/GiB/);
      expect(await descriptionOf({ ramGiB: 31 })).not.toMatch(/GiB/);
    });

    it('allows 5% under 32 GiB, so a "32 GB" Linux box that reports 31 GiB is not warned', async () => {
      expect(await descriptionOf({ ramGiB: 30.5 })).not.toMatch(/GiB/);
      expect(await descriptionOf({ ramGiB: 30 })).toMatch(/This machine has 30\.0 GiB of RAM/);
    });

    it('warns with the amount the machine has', async () => {
      const text = await descriptionOf({ ramGiB: 24 });

      expect(text).toMatch(/This machine has 24\.0 GiB of RAM; quality needs about 32 GB\./);
    });

    it('names the container limit inside Docker', async () => {
      const text = await descriptionOf({ inDocker: true, ramGiB: 64, memoryLimitGiB: 8 });

      expect(text).toMatch(/Docker limits this container to 8\.0 GiB \(the container limit\)/);
    });

    it('takes the smaller of the container limit and the memory it sees', async () => {
      const text = await descriptionOf({ inDocker: true, ramGiB: 16, memoryLimitGiB: 64 });

      expect(text).toMatch(/Docker shows this container 16\.0 GiB of RAM/);
      expect(text).not.toMatch(/container limit/);
    });

    it('says what Docker shows when the container has no limit', async () => {
      const text = await descriptionOf({ inDocker: true, ramGiB: 12 });

      expect(text).toMatch(
        /Docker shows this container 12\.0 GiB of RAM; quality needs about 32 GB/,
      );
      expect(text).toMatch(/Ollama may run elsewhere/);
    });

    it('does not warn inside Docker when the limit is enough', async () => {
      const text = await descriptionOf({ inDocker: true, ramGiB: 64, memoryLimitGiB: 48 });

      expect(text).not.toMatch(/GiB/);
    });

    it('keeps the memory warning off the other profiles', async () => {
      expect(await descriptionOf({ ramGiB: 8 }, 'light')).not.toMatch(/GiB/);
      expect(await descriptionOf({ ramGiB: 8 }, 'fast')).not.toMatch(/GiB/);
    });
  });

  describe('what the profile question says about light', () => {
    const lightOn = async (options: Parameters<typeof harness>[0]): Promise<string> => {
      const h = harness(options);
      await initCommand({ config: CONFIG_PATH }, h.io);
      const call = h.calls.find((c) => c.kind === 'select');
      return call?.options.choices?.find((c) => c.value === 'light')?.description ?? '';
    };

    it('promises 16 GB on a Mac', async () => {
      const text = await lightOn({ platform: 'darwin' });

      expect(text).toMatch(/Fits in 16 GB/);
      expect(text).not.toMatch(/fallback/);
    });

    it.each(['linux', 'win32'] as const)(
      'says on %s that it falls back to larger models that need far more than 16 GB',
      async (platform) => {
        const text = await lightOn({ platform });

        expect(text).toMatch(/larger fallback models.*much more than 16 GB/);
        expect(text).toMatch(/digest doctor/);
      },
    );

    it('judges the Mac that runs Ollama, not the Linux container, when Docker names its host', async () => {
      const named = await lightOn({
        inDocker: true,
        platform: 'linux',
        env: { DIGEST_HOST_OS: 'Darwin' },
      });
      const unnamed = await lightOn({ inDocker: true, platform: 'linux' });

      expect(named).not.toMatch(/fallback/);
      expect(unnamed).toMatch(/larger fallback models/);
    });
  });

  describe('the summary', () => {
    it('notes that quality is unmeasured when it was chosen', async () => {
      const h = harness({ rules: [[/Model profile/, 'quality']] });

      await initCommand({ config: CONFIG_PATH }, h.io);

      expect(h.out.join('')).toMatch(/note:.*quality is not measured yet.*about 1 h/);
    });

    it('has no such note for the other profiles', async () => {
      for (const profile of ['light', 'fast']) {
        const h = harness({ rules: [[/Model profile/, profile]] });

        await initCommand({ config: CONFIG_PATH }, h.io);

        expect(h.out.join(''), profile).not.toMatch(/not measured yet/);
      }
    });
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

describe('files that make docker-init created empty', () => {
  it('counts empty files as absent, so --yes works', async () => {
    const h = harness({ empty: [CONFIG_PATH, ENV_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.files.get(CONFIG_PATH)?.content).toContain('"focusAreas"');
    expect(h.files.get(ENV_PATH)?.secret).toBe(true);
  });

  it('does not ask whether to overwrite them', async () => {
    const h = harness({ empty: [CONFIG_PATH, ENV_PATH] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.calls.some((c) => /Overwrite/.test(c.message))).toBe(false);
  });

  it('still refuses a file with content, and names only that one', async () => {
    const h = harness({ existing: [CONFIG_PATH], empty: [ENV_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(CONFIG_PATH);
    expect(h.err.join('')).not.toContain(ENV_PATH);
  });

  it('asks about the config with content only', async () => {
    const h = harness({ existing: [CONFIG_PATH], empty: [ENV_PATH], rules: [[/Overwrite/, true]] });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const question = h.calls.find((c) => /Overwrite/.test(c.message));
    expect(question?.message).toContain(CONFIG_PATH);
    expect(question?.message).not.toContain(ENV_PATH);
  });

  it('writes a fresh .env into an empty one, with no merge', async () => {
    const h = harness({ empty: [CONFIG_PATH, ENV_PATH] });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toContain('# Written by "digest init"');
    expect(writtenEnvText(h)).toContain('# GITHUB_TOKEN=');
  });
});

describe('merging into an existing .env', () => {
  const HAND_WRITTEN = [
    '# my settings, written by hand',
    'LOG_LEVEL=debug',
    '',
    'GITHUB_TOKEN="ghp_a token # with a hash"',
    'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces',
    '',
  ].join('\n');

  it('keeps every other line as it was, in its place, and adds OLLAMA_URL at the end', async () => {
    const h = harness({ envText: HAND_WRITTEN });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe(`${HAND_WRITTEN}OLLAMA_URL=http://localhost:11434\n`);
  });

  it('keeps an OLLAMA_URL that was set by hand', async () => {
    const h = harness({ envText: 'OLLAMA_URL=http://gpu-box:11434\nLOG_LEVEL=debug\n' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe('OLLAMA_URL=http://gpu-box:11434\nLOG_LEVEL=debug\n');
  });

  it('fills an OLLAMA_URL that is empty', async () => {
    const h = harness({ envText: 'LOG_LEVEL=debug\nOLLAMA_URL=\n' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe('LOG_LEVEL=debug\nOLLAMA_URL=http://localhost:11434\n');
  });

  it('replaces the secrets it was given, wherever they stand, and keeps the rest', async () => {
    const envText = [
      'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/OLD/OLD/old',
      'GITHUB_TOKEN=ghp_keep',
      'export SMTP_PASSWORD=old-password',
      'OLLAMA_URL=http://localhost:11434',
      '',
    ].join('\n');
    const h = harness({
      envText,
      rules: [[/Also deliver/, ['email', 'slack']], ...EMAIL_RULES, ...SLACK_RULES.slice(1)],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe(
      [
        'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/hook-secret',
        'GITHUB_TOKEN=ghp_keep',
        'export SMTP_PASSWORD=smtp-secret',
        'OLLAMA_URL=http://localhost:11434',
        '',
      ].join('\n'),
    );
  });

  it('adds a secret that is not in the file yet, and quotes it like a fresh file does', async () => {
    const rules: Rule[] = [
      [/SMTP password/, 'pa ss#word'],
      ...EMAIL_RULES.filter(([p]) => !/SMTP password/.test(p.source)),
    ];
    const h = harness({ envText: HAND_WRITTEN, rules });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)).toMatchObject({ SMTP_PASSWORD: 'pa ss#word', LOG_LEVEL: 'debug' });
    expect(writtenEnvText(h).startsWith(HAND_WRITTEN)).toBe(true);
  });

  it('keeps a secret it was not given this time', async () => {
    const h = harness({ envText: 'SMTP_PASSWORD=still-needed\nSLACK_WEBHOOK_URL=https://h/s/x\n' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)).toMatchObject({
      SMTP_PASSWORD: 'still-needed',
      SLACK_WEBHOOK_URL: 'https://h/s/x',
    });
  });

  it('replaces every copy of a key, so no stale duplicate wins', async () => {
    const h = harness({
      envText: 'SMTP_PASSWORD=one\nLOG_LEVEL=debug\nSMTP_PASSWORD=two\n',
      rules: [[/Also deliver/, ['email']], ...EMAIL_RULES],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe(
      'SMTP_PASSWORD=smtp-secret\nLOG_LEVEL=debug\nSMTP_PASSWORD=smtp-secret\nOLLAMA_URL=http://localhost:11434\n',
    );
  });

  it('keeps Windows line endings', async () => {
    const h = harness({
      envText: 'LOG_LEVEL=debug\r\nSMTP_PASSWORD=old\r\n',
      rules: [[/Also deliver/, ['email']], ...EMAIL_RULES],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe(
      'LOG_LEVEL=debug\r\nSMTP_PASSWORD=smtp-secret\r\nOLLAMA_URL=http://localhost:11434\r\n',
    );
  });

  it('starts a new line when the file does not end with one', async () => {
    const h = harness({ envText: 'LOG_LEVEL=debug' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe('LOG_LEVEL=debug\nOLLAMA_URL=http://localhost:11434\n');
  });

  it('treats a file with only blank lines as empty and writes a fresh one', async () => {
    const h = harness({ envText: '\n  \n' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toContain('# Written by "digest init"');
  });

  it('writes the merged file through the owner-only writer', async () => {
    const h = harness({ envText: HAND_WRITTEN });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.files.get(ENV_PATH)?.secret).toBe(true);
  });

  it('leaves the loader reading every other value as before', async () => {
    const h = harness({ envText: HAND_WRITTEN });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)).toEqual({
      ...parseEnv(HAND_WRITTEN),
      OLLAMA_URL: 'http://localhost:11434',
    });
  });

  it('refuses, and writes nothing, when a line it would replace is part of another value', async () => {
    const trap = 'NOTE="first line\nSMTP_PASSWORD=inside the note"\nLOG_LEVEL=debug\n';
    const h = harness({ envText: trap, rules: [[/Also deliver/, ['email']], ...EMAIL_RULES] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toMatch(/Could not merge into .*\.env safely.*by hand/s);
  });

  it('refuses, and writes nothing, when .env cannot be read', async () => {
    const h = harness({
      envText: 'x=1\n',
      envReadError: Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }),
    });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(`Could not read ${ENV_PATH}: EACCES: denied`);
  });

  it('says in the summary that it updated .env and kept the rest', async () => {
    const h = harness({ envText: HAND_WRITTEN });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    const text = h.out.join('');
    expect(text).toContain(`Wrote ${CONFIG_PATH}`);
    expect(text).toMatch(/updated .*\.env.*kept its other settings/);
  });

  it('keeps the plain wording for a fresh file', async () => {
    const h = harness();

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.out.join('')).toContain(
      `Wrote ${CONFIG_PATH} and ${ENV_PATH} (readable by you only).`,
    );
  });
});

describe('schedule time zone', () => {
  const zoneCall = (h: Harness): PromptCall | undefined =>
    h.calls.find((c) => /Time zone/.test(c.message));

  it('writes the zone this process runs in with --yes', async () => {
    const h = harness({ timeZone: 'Asia/Tokyo' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['schedule']).toEqual({ timeZone: 'Asia/Tokyo' });
    expect(zoneCall(h)).toBeUndefined();
  });

  it('offers the detected zone as the default and writes it on Enter', async () => {
    const h = harness({ timeZone: 'America/Chicago' });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(zoneCall(h)?.kind).toBe('input');
    expect(zoneCall(h)?.options.default).toBe('America/Chicago');
    expect(writtenConfig(h)['schedule']).toEqual({ timeZone: 'America/Chicago' });
  });

  it('writes the zone the user types, trimmed', async () => {
    const h = harness({ rules: [[/Time zone/, '  America/New_York ']] });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['schedule']).toEqual({ timeZone: 'America/New_York' });
  });

  it.each(['Mars/Phobos', 'Berlin', '', '   '])('rejects "%s" as a zone', async (typed) => {
    const h = harness();
    await initCommand({ config: CONFIG_PATH }, h.io);

    const verdict = zoneCall(h)?.options.validate?.(typed);

    expect(verdict).toEqual(expect.stringMatching(/time zone/i));
  });

  it.each(['Europe/Berlin', 'UTC', 'Asia/Kolkata'])('accepts %s as a zone', async (typed) => {
    const h = harness();
    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(zoneCall(h)?.options.validate?.(typed)).toBe(true);
  });

  it('says in the prompt that a container runs on UTC unless TZ is set', async () => {
    const h = harness({ inDocker: true, timeZone: 'UTC' });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const message = zoneCall(h)?.message ?? '';
    expect(message).toContain('UTC');
    expect(message).toContain('TZ');
    expect(zoneCall(h)?.options.default).toBe('UTC');
  });

  it('keeps the prompt plain outside Docker, even on a UTC machine', async () => {
    const h = harness({ timeZone: 'UTC' });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(zoneCall(h)?.message).not.toContain('Docker');
  });

  it('does not blame Docker when TZ already gave the container a real zone', async () => {
    const h = harness({ inDocker: true, timeZone: 'Europe/Berlin' });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(zoneCall(h)?.message).not.toContain('UTC');
  });

  it('warns after --yes in Docker that UTC was used, and how to change it', async () => {
    const h = harness({ inDocker: true, timeZone: 'UTC' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    const printed = h.out.join('');
    expect(printed).toContain('schedule.timeZone');
    expect(printed).toMatch(/UTC/);
    expect(writtenConfig(h)['schedule']).toEqual({ timeZone: 'UTC' });
  });

  it('lists the zone in the summary', async () => {
    const h = harness({ timeZone: 'Asia/Tokyo' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.out.join('')).toContain('Asia/Tokyo');
  });
});

describe('in Docker, where the files are single-file bind mounts', () => {
  let dir: string;
  let envPath: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-init-docker-'));
    envPath = join(dir, '.env');
    configPath = join(dir, 'digest.config.json');
  });

  beforeEach(() => {
    vi.mocked(rename).mockClear();
  });

  afterEach(async () => {
    // Drops failures a test queued but the code never asked for, so they cannot leak.
    vi.mocked(rename).mockReset();
    vi.mocked(chmod).mockReset();
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  const errnoError = (code: string): Error =>
    Object.assign(new Error(`${code}: operation failed`), { code });

  function diskIo(overrides: Partial<InitIo> = {}): { io: Partial<InitIo>; err: string[] } {
    const err: string[] = [];
    const io: Partial<InitIo> = {
      prompts: scriptedPrompts([[/Overwrite/, true]]).prompts,
      env: { DIGEST_HOST_OS: 'darwin' },
      platform: 'linux',
      totalMemoryBytes: 32 * GIB,
      timeZone: 'Europe/Berlin',
      cwd: dir,
      envPath,
      renderSchedule: () => SCHEDULE,
      stdout: () => undefined,
      stderr: (text) => err.push(text),
      ...overrides,
    };
    return { io, err };
  }

  /** What `make docker-init` leaves behind. */
  async function createEmptyFiles(): Promise<void> {
    await writeFile(configPath, '', { mode: 0o644 });
    await writeFile(envPath, '', { mode: 0o600 });
  }

  const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
  const leftovers = async (): Promise<string[]> =>
    (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

  it('writes both empty files that make docker-init created', async () => {
    await createEmptyFiles();
    const { io } = diskIo();

    const code = await initCommand({ yes: true, config: configPath }, io);

    expect(code).toBe(0);
    const loaded = await loadConfig({ configPath, envPath, processEnv: {} });
    expect(loaded.config.schedule.timeZone).toBe('Europe/Berlin');
    expect(loaded.env.OLLAMA_URL).toBe('http://localhost:11434');
    expect(await modeOf(envPath)).toBe(0o600);
  });

  it.each(['EBUSY', 'EXDEV', 'EACCES', 'EPERM'])(
    'writes .env in place when the rename fails with %s',
    async (code) => {
      await createEmptyFiles();
      const before = await stat(envPath);
      vi.mocked(rename).mockRejectedValueOnce(errnoError(code));
      const { io, err } = diskIo();

      const exitCode = await initCommand({ yes: true, config: configPath }, io);

      expect(err).toEqual([]);
      expect(exitCode).toBe(0);
      const after = await stat(envPath);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      expect(await readFile(envPath, 'utf8')).toContain('OLLAMA_URL=');
      expect(await leftovers()).toEqual([]);
    },
  );

  it('tightens a world-readable .env before writing secrets into it in place', async () => {
    await writeFile(envPath, 'SMTP_PASSWORD=old\n', { mode: 0o644 });
    await chmod(envPath, 0o644);
    vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
    const { io } = diskIo();

    const code = await initCommand({ config: configPath }, io);

    expect(code).toBe(0);
    expect(await modeOf(envPath)).toBe(0o600);
    // The merge keeps the line it was not asked to change, in the file that is written in place.
    expect(await readFile(envPath, 'utf8')).toBe(
      'SMTP_PASSWORD=old\nOLLAMA_URL=http://localhost:11434\n',
    );
  });

  it('accepts a chmod that is refused when the file is already owner-only', async () => {
    await createEmptyFiles();
    vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
    vi.mocked(chmod).mockRejectedValueOnce(errnoError('EPERM'));
    const { io } = diskIo();

    const code = await initCommand({ yes: true, config: configPath }, io);

    expect(code).toBe(0);
    expect(await readFile(envPath, 'utf8')).toContain('OLLAMA_URL=');
  });

  it('writes nothing into a world-readable .env it cannot tighten', async () => {
    await createEmptyFiles();
    await chmod(envPath, 0o644);
    vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
    vi.mocked(chmod).mockRejectedValueOnce(errnoError('EPERM'));
    const { io, err } = diskIo();

    const code = await initCommand({ yes: true, config: configPath }, io);

    expect(code).toBe(1);
    expect(err.join('')).toContain(envPath);
    expect(err.join('')).toContain('DIGEST_UID');
    expect(await readFile(envPath, 'utf8')).toBe('');
  });

  it('writes nothing into a world-readable .env when chmod says yes but changes nothing', async () => {
    await createEmptyFiles();
    await chmod(envPath, 0o644);
    vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
    vi.mocked(chmod).mockResolvedValueOnce(undefined);
    const { io, err } = diskIo();

    const code = await initCommand({ yes: true, config: configPath }, io);

    expect(code).toBe(1);
    expect(err.join('')).toContain('still readable by others');
    expect(await readFile(envPath, 'utf8')).toBe('');
  });

  it('does not fall back for an error that is not about the bind mount', async () => {
    await writeFile(envPath, 'KEEP=me\n', { mode: 0o600 });
    vi.mocked(rename).mockRejectedValueOnce(errnoError('ENOSPC'));
    const { io, err } = diskIo();

    const code = await initCommand({ config: configPath }, io);

    expect(code).toBe(1);
    expect(err.join('')).toContain(`Could not write ${envPath}`);
    expect(err.join('')).toContain('ENOSPC');
    expect(await readFile(envPath, 'utf8')).toBe('KEEP=me\n');
    expect(await leftovers()).toEqual([]);
  });

  it('keeps the temp file and rename path wherever the rename works', async () => {
    await writeFile(envPath, 'SMTP_PASSWORD=old\n', { mode: 0o644 });
    const before = await stat(envPath);
    const { io } = diskIo();

    const code = await initCommand({ config: configPath }, io);

    expect(code).toBe(0);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rename).mock.calls[0]?.[1]).toBe(envPath);
    expect((await stat(envPath)).ino).not.toBe(before.ino);
    expect(await modeOf(envPath)).toBe(0o600);
    expect(await leftovers()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'writes in place when the folder is read-only, as /app is for the node user',
    async () => {
      await createEmptyFiles();
      await chmod(dir, 0o555);
      const { io, err } = diskIo();

      const code = await initCommand({ yes: true, config: configPath }, io);

      expect(err).toEqual([]);
      expect(code).toBe(0);
      expect(await readFile(envPath, 'utf8')).toContain('OLLAMA_URL=');
      expect(await modeOf(envPath)).toBe(0o600);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'fails with the file name when the folder is read-only and there is no file to write in place',
    async () => {
      await writeFile(configPath, '', { mode: 0o644 });
      await chmod(dir, 0o555);
      const { io, err } = diskIo();

      const code = await initCommand({ yes: true, config: configPath }, io);

      expect(code).toBe(1);
      expect(err.join('')).toContain(`Could not write ${envPath}`);
    },
  );
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

  it('merges into an existing world-readable .env, keeps its other settings and tightens its mode', async () => {
    const configPath = join(dir, 'digest.config.json');
    await writeFile(join(dir, '.env'), 'GITHUB_TOKEN=ghp_keep\nLOG_LEVEL=debug\n', { mode: 0o644 });

    const code = await initCommand({ yes: true, config: configPath }, realIo());

    expect(code).toBe(0);
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      'GITHUB_TOKEN=ghp_keep\nLOG_LEVEL=debug\nOLLAMA_URL=http://localhost:11434\n',
    );
    const loaded = await loadConfig({ configPath, envPath: join(dir, '.env'), processEnv: {} });
    expect(loaded.secrets.GITHUB_TOKEN).toBe('ghp_keep');
    expect(loaded.env.LOG_LEVEL).toBe('debug');
  });

  it('replaces the secret it was given in a real .env and the loader reads the new one', async () => {
    const configPath = join(dir, 'digest.config.json');
    await writeFile(join(dir, '.env'), 'SMTP_PASSWORD=old\nGITHUB_TOKEN=ghp_keep\n', {
      mode: 0o600,
    });
    const rules: Rule[] = [[/Also deliver/, ['email']], ...EMAIL_RULES];

    await initCommand({ config: configPath }, realIo({ prompts: scriptedPrompts(rules).prompts }));

    const loaded = await loadConfig({ configPath, envPath: join(dir, '.env'), processEnv: {} });
    expect(loaded.secrets).toEqual({ SMTP_PASSWORD: 'smtp-secret', GITHUB_TOKEN: 'ghp_keep' });
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
    expect(inquirer.input).toHaveBeenCalledTimes(2);
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
