import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  formatEnvValue,
  loadConfig,
  mergeEnvText,
  platformOf,
  redactSecrets,
  resolveHostPlatform,
  type LoadOptions,
} from '../../src/config/load.js';
import { NON_MAC_FALLBACK, PROFILES } from '../../src/config/profiles.js';
import { createRedactor } from '../../src/observability/redact.js';
import { SecretsSchema } from '../../src/config/schema.js';
import { DigestError } from '../../src/shared/errors.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'config');
const fixture = (name: string): string => join(fixtures, name);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mac = { os: 'darwin', arch: 'arm64' } as const;
const linux = { os: 'linux', arch: 'x64' } as const;

/** Options that never touch the real working directory or process environment. */
const base = (overrides: LoadOptions = {}): LoadOptions => ({
  configPath: fixture('valid.config.json'),
  envPath: fixture('missing.env'),
  processEnv: {},
  platform: mac,
  ...overrides,
});

async function failure(options: LoadOptions): Promise<DigestError> {
  const error = await loadConfig(options).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DigestError);
  return error as DigestError;
}

describe('loadConfig', () => {
  it('loads a valid config with defaults', async () => {
    const loaded = await loadConfig(base());

    expect(loaded.configPath).toBe(fixture('valid.config.json'));
    expect(loaded.config).toMatchObject({
      profile: 'quality',
      windowDays: 7,
      topN: 5,
      schedule: { cron: '45 7 * * 1', timeZone: 'Europe/Berlin' },
      delivery: { markdown: { dir: 'data/digests' } },
      models: { retries: 2 },
    });
    expect(loaded.env).toEqual({ OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' });
    expect(loaded.secrets).toEqual({});
    expect(loaded.profile).toEqual(PROFILES.quality);
  });

  it('defaults to digest.config.json in the working directory', async () => {
    const project = join(fixtures, 'project');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const loaded = await loadConfig({ processEnv: {}, platform: mac });
    expect(loaded.configPath).toBe(join(project, 'digest.config.json'));
  });

  it('reports the default path in the working directory when it is missing', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(fixtures);
    const error = await failure({ processEnv: {}, platform: mac });
    expect(error.message).toBe(
      `No digest.config.json found at ${join(fixtures, 'digest.config.json')}. Run "digest init" first.`,
    );
  });

  describe('readable errors', () => {
    it('names the path and suggests digest init when the file is missing', async () => {
      const path = fixture('nope.config.json');
      const error = await failure(base({ configPath: path }));
      expect(error.message).toBe(
        `No digest.config.json found at ${path}. Run "digest init" first.`,
      );
    });

    it('names the path and the parse problem for invalid JSON', async () => {
      const path = fixture('invalid-json.config.txt');
      const error = await failure(base({ configPath: path }));
      expect(error.message).toMatch(
        new RegExp(`^Invalid JSON in ${escapeRegExp(path)}: .*Unexpected token`),
      );
      expect(error.cause).toBeInstanceOf(SyntaxError);
    });

    it('names the position when the parser reports one', async () => {
      const path = fixture('trailing-comma.config.txt');
      const error = await failure(base({ configPath: path }));
      expect(error.message).toContain(`Invalid JSON in ${path}`);
      expect(error.message).toMatch(/position \d+/);
    });

    it('names the path and every offending field for schema errors', async () => {
      const path = fixture('bad-schema.config.json');
      const error = await failure(base({ configPath: path }));
      expect(error.message).toContain(`Invalid config in ${path}`);
      expect(error.message).toContain('profile');
      expect(error.message).toContain('focusAreas');
      expect(error.message).toContain('topN');
    });

    it('wraps unreadable paths without losing the cause', async () => {
      // A directory exists but cannot be read as a file.
      const error = await failure(base({ configPath: fixtures }));
      expect(error.message).toContain(`Cannot read ${fixtures}`);
      expect(error.cause).toBeInstanceOf(Error);
    });

    it('names the env file and variable for invalid secrets or settings', async () => {
      const envPath = fixture('bad-env.env');
      const error = await failure(base({ envPath }));
      expect(error.message).toContain('Invalid environment');
      expect(error.message).toContain('SLACK_WEBHOOK_URL');
      expect(error.message).not.toContain('not-a-url');
    });

    it('never echoes secret values in an env validation error', async () => {
      const error = await failure(
        base({ processEnv: { SLACK_WEBHOOK_URL: 'super-secret-not-a-url' } }),
      );
      expect(error.message).toContain('SLACK_WEBHOOK_URL');
      expect(error.message).not.toContain('super-secret-not-a-url');
    });
  });

  describe('environment', () => {
    it('reads secrets and settings from the env file', async () => {
      const loaded = await loadConfig(base({ envPath: fixture('secrets.env') }));
      expect(loaded.secrets).toEqual({
        SMTP_PASSWORD: 'file-smtp-password',
        SLACK_WEBHOOK_URL: 'https://hooks.example.com/services/FILE',
      });
      expect(loaded.env).toEqual({ OLLAMA_URL: 'http://file-host:11434', LOG_LEVEL: 'debug' });
    });

    it('lets process env win over the env file', async () => {
      const loaded = await loadConfig(
        base({
          envPath: fixture('secrets.env'),
          processEnv: { SMTP_PASSWORD: 'process-smtp-password', LOG_LEVEL: 'warn' },
        }),
      );
      expect(loaded.secrets.SMTP_PASSWORD).toBe('process-smtp-password');
      expect(loaded.env.LOG_LEVEL).toBe('warn');
      expect(loaded.env.OLLAMA_URL).toBe('http://file-host:11434');
    });

    it('treats empty strings as unset', async () => {
      const loaded = await loadConfig(
        base({
          envPath: fixture('secrets.env'),
          processEnv: { GITHUB_TOKEN: '', SMTP_PASSWORD: '', OLLAMA_URL: '' },
        }),
      );
      expect(loaded.secrets.GITHUB_TOKEN).toBeUndefined();
      // An empty process value does not shadow the file value.
      expect(loaded.secrets.SMTP_PASSWORD).toBe('file-smtp-password');
      expect(loaded.env.OLLAMA_URL).toBe('http://file-host:11434');
    });

    it('works without any env file', async () => {
      const loaded = await loadConfig(base({ processEnv: { GITHUB_TOKEN: 'ghp_from_process' } }));
      expect(loaded.secrets).toEqual({ GITHUB_TOKEN: 'ghp_from_process' });
    });

    it('ignores unrelated variables', async () => {
      const loaded = await loadConfig(base({ processEnv: { PATH: '/usr/bin', HOME: '/home/x' } }));
      expect(loaded.secrets).toEqual({});
      expect(Object.keys(loaded.env).sort()).toEqual(['LOG_LEVEL', 'OLLAMA_URL']);
    });

    it('defaults to the real process environment', async () => {
      vi.stubEnv('LOG_LEVEL', 'error');
      try {
        const { processEnv: _omitted, ...options } = base();
        const loaded = await loadConfig(options);
        expect(loaded.env.LOG_LEVEL).toBe('error');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('profile resolution', () => {
    it('uses the profile as configured on Apple silicon', async () => {
      const loaded = await loadConfig(base({ platform: mac }));
      expect(loaded.profile.writers).toEqual(PROFILES.quality.writers);
      expect(loaded.profile.requiresAppleSilicon).toBe(true);
    });

    it('falls back to the untuned non-Mac profile elsewhere', async () => {
      const loaded = await loadConfig(base({ platform: linux }));
      expect(loaded.profile).toEqual({ ...NON_MAC_FALLBACK, name: 'quality' });
    });

    it('lets models.writers override the profile panel', async () => {
      const loaded = await loadConfig(base({ configPath: fixture('writers.config.json') }));
      expect(loaded.profile.writers).toEqual(['custom-writer:1b']);
      expect(loaded.profile.judge).toBeNull();
    });

    it('applies the writers override on top of the non-Mac fallback', async () => {
      const loaded = await loadConfig(
        base({ configPath: fixture('writers.config.json'), platform: linux }),
      );
      expect(loaded.profile.writers).toEqual(['custom-writer:1b']);
      expect(loaded.profile.classify).toBe(NON_MAC_FALLBACK.classify);
    });

    it('defaults the platform to the running process', async () => {
      const { platform: _omitted, ...options } = base();
      const original = {
        platform: Object.getOwnPropertyDescriptor(process, 'platform'),
        arch: Object.getOwnPropertyDescriptor(process, 'arch'),
      };
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
      try {
        const loaded = await loadConfig(options);
        expect(loaded.profile.writers).toEqual(NON_MAC_FALLBACK.writers);
      } finally {
        if (original.platform) Object.defineProperty(process, 'platform', original.platform);
        if (original.arch) Object.defineProperty(process, 'arch', original.arch);
      }
    });
  });
});

describe('resolveHostPlatform', () => {
  const process_ = { os: 'linux', arch: 'x64' } as const;

  it('uses the running process when the host is not named', () => {
    expect(resolveHostPlatform({}, process_)).toEqual(process_);
  });

  it.each([
    ['darwin', 'darwin'],
    ['Darwin', 'darwin'],
    ['linux', 'linux'],
    ['Linux', 'linux'],
    ['win32', 'win32'],
    ['windows', 'win32'],
    ['Windows', 'win32'],
    ['MINGW64_NT-10.0-22631', 'win32'],
    ['MSYS_NT-10.0-22631', 'win32'],
  ])('reads the OS %s as %s', (spelling, os) => {
    expect(resolveHostPlatform({ DIGEST_HOST_OS: spelling }, process_).os).toBe(os);
  });

  it.each([
    ['arm64', 'arm64'],
    ['aarch64', 'arm64'],
    ['AARCH64', 'arm64'],
    ['x86_64', 'x64'],
    ['amd64', 'x64'],
    ['x64', 'x64'],
  ])('reads the CPU %s as %s', (spelling, arch) => {
    expect(resolveHostPlatform({ DIGEST_HOST_ARCH: spelling }, process_).arch).toBe(arch);
  });

  it.each([[''], ['  ']])('treats the blank value %j as not named', (blank) => {
    expect(
      resolveHostPlatform({ DIGEST_HOST_OS: blank, DIGEST_HOST_ARCH: blank }, process_),
    ).toEqual(process_);
  });

  it('takes each part from the process when only the other one is named', () => {
    expect(resolveHostPlatform({ DIGEST_HOST_OS: 'Darwin' }, process_)).toEqual({
      os: 'darwin',
      arch: 'x64',
    });
    expect(resolveHostPlatform({ DIGEST_HOST_ARCH: 'arm64' }, process_)).toEqual({
      os: 'linux',
      arch: 'arm64',
    });
  });

  it.each([
    ['DIGEST_HOST_OS', 'plan9'],
    ['DIGEST_HOST_ARCH', 'riscv128'],
  ])('names %s when it holds an unknown value', (variable, value) => {
    const run = (): unknown => resolveHostPlatform({ [variable]: value }, process_);
    expect(run).toThrow(DigestError);
    expect(run).toThrow(variable);
    expect(run).toThrow(value);
  });
});

describe('host platform override (Docker on a Mac)', () => {
  const containerOnLinux = async <T>(action: () => Promise<T>): Promise<T> => {
    const original = {
      platform: Object.getOwnPropertyDescriptor(process, 'platform'),
      arch: Object.getOwnPropertyDescriptor(process, 'arch'),
    };
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      return await action();
    } finally {
      if (original.platform) Object.defineProperty(process, 'platform', original.platform);
      if (original.arch) Object.defineProperty(process, 'arch', original.arch);
    }
  };
  const { platform: _omitted, ...withoutPlatform } = base();

  it('keeps the quality profile inside a Linux container on an Apple silicon host', async () => {
    const loaded = await containerOnLinux(() =>
      loadConfig({
        ...withoutPlatform,
        processEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' },
      }),
    );

    expect(loaded.profile).toEqual(PROFILES.quality);
  });

  it('accepts the uname spelling that make docker-* exports', async () => {
    const loaded = await containerOnLinux(() =>
      loadConfig({
        ...withoutPlatform,
        processEnv: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'aarch64' },
      }),
    );

    expect(loaded.profile).toEqual(PROFILES.quality);
  });

  it('falls back when the host is an Intel Mac', async () => {
    const loaded = await containerOnLinux(() =>
      loadConfig({
        ...withoutPlatform,
        processEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'x86_64' },
      }),
    );

    expect(loaded.profile).toEqual({ ...NON_MAC_FALLBACK, name: 'quality' });
  });

  it('falls back when the host is Linux', async () => {
    const loaded = await containerOnLinux(() =>
      loadConfig({ ...withoutPlatform, processEnv: { DIGEST_HOST_OS: 'Linux' } }),
    );

    expect(loaded.profile).toEqual({ ...NON_MAC_FALLBACK, name: 'quality' });
  });

  it('assumes the container has the CPU of the host when only the OS is named', async () => {
    const loaded = await containerOnLinux(() =>
      loadConfig({ ...withoutPlatform, processEnv: { DIGEST_HOST_OS: 'darwin' } }),
    );

    expect(loaded.profile).toEqual(PROFILES.quality);
  });

  it('reads the override from the env file too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digest-load-'));
    try {
      const envPath = join(dir, '.env');
      await writeFile(envPath, 'DIGEST_HOST_OS=Darwin\nDIGEST_HOST_ARCH=arm64\n');

      const loaded = await containerOnLinux(() => loadConfig({ ...withoutPlatform, envPath }));

      expect(loaded.profile).toEqual(PROFILES.quality);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lets an explicit platform win over the environment', async () => {
    const loaded = await loadConfig(
      base({
        platform: linux,
        processEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' },
      }),
    );

    expect(loaded.profile).toEqual({ ...NON_MAC_FALLBACK, name: 'quality' });
  });

  it('does not look at the override when an explicit platform is given', async () => {
    const loaded = await loadConfig(base({ processEnv: { DIGEST_HOST_OS: 'plan9' } }));

    expect(loaded.profile).toEqual(PROFILES.quality);
  });

  it('reports an unknown host OS as a config error that names the variable', async () => {
    const error = await failure(withPlatformOmitted({ processEnv: { DIGEST_HOST_OS: 'plan9' } }));

    expect(error.message).toContain('DIGEST_HOST_OS');
    expect(error.message).toContain('plan9');
  });

  it('reports an unknown host CPU as a config error that names the variable', async () => {
    const error = await failure(
      withPlatformOmitted({ processEnv: { DIGEST_HOST_ARCH: 'riscv128' } }),
    );

    expect(error.message).toContain('DIGEST_HOST_ARCH');
  });

  it('still reads DIGEST_HOST_OS into the environment settings', async () => {
    const loaded = await loadConfig(
      base({ processEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' } }),
    );

    expect(loaded.env).toMatchObject({ DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' });
  });

  function withPlatformOmitted(overrides: LoadOptions): LoadOptions {
    return { ...withoutPlatform, ...overrides };
  }
});

describe('redactSecrets', () => {
  const secrets = SecretsSchema.parse({
    SMTP_PASSWORD: 'hunter2-password',
    SLACK_WEBHOOK_URL: 'https://hooks.example.com/services/T000/B000/XXXX',
    GITHUB_TOKEN: 'ghp_exampletoken',
  });

  it('replaces every occurrence of every secret', () => {
    const text =
      'smtp hunter2-password then hunter2-password again; ' +
      'POST https://hooks.example.com/services/T000/B000/XXXX; token=ghp_exampletoken';
    expect(redactSecrets(text, secrets)).toBe(
      'smtp [redacted] then [redacted] again; POST [redacted]; token=[redacted]',
    );
  });

  it('returns text unchanged when there are no secrets to find', () => {
    expect(redactSecrets('nothing to see', secrets)).toBe('nothing to see');
    expect(redactSecrets('nothing to see', {})).toBe('nothing to see');
  });

  it('does not treat empty values as secrets', () => {
    const empty = { SMTP_PASSWORD: '', GITHUB_TOKEN: undefined } as unknown as typeof secrets;
    expect(redactSecrets('abc', empty)).toBe('abc');
  });

  it('treats secret values literally, not as patterns', () => {
    const tricky = { SMTP_PASSWORD: 'a.b*c(d)' };
    expect(redactSecrets('pw=a.b*c(d) axbbc(d)', tricky)).toBe('pw=[redacted] axbbc(d)');
  });

  it('redacts a secret that contains another secret first', () => {
    const nested = { SMTP_PASSWORD: 'tok', GITHUB_TOKEN: 'tok-longer' };
    expect(redactSecrets('x tok-longer y tok', nested)).toBe('x [redacted] y [redacted]');
  });
});

describe('LoadedConfig.platform', () => {
  it('is the platform the profile was resolved for', async () => {
    const loaded = await loadConfig(base({ platform: linux }));

    expect(loaded.platform).toEqual(linux);
    expect(loaded.profile).toEqual({ ...NON_MAC_FALLBACK, name: 'quality' });
  });

  it('comes from DIGEST_HOST_OS/DIGEST_HOST_ARCH when no platform is passed', async () => {
    const { platform: _omitted, ...withoutPlatform } = base();

    const loaded = await loadConfig({
      ...withoutPlatform,
      processEnv: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'aarch64' },
    });

    expect(loaded.platform).toEqual(mac);
  });

  it('falls back to the running process when nothing is named', async () => {
    const { platform: _omitted, ...withoutPlatform } = base();

    const loaded = await loadConfig(withoutPlatform);

    expect(loaded.platform).toEqual({ os: process.platform, arch: process.arch });
  });
});

describe('platformOf', () => {
  const env = { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' } as const;

  it('returns the platform the loader resolved', () => {
    expect(platformOf({ platform: mac })).toEqual(mac);
  });

  it('does not look at the host variables in the environment again', () => {
    const loaded = {
      env: { ...env, DIGEST_HOST_OS: 'linux', DIGEST_HOST_ARCH: 'x86_64' },
      platform: mac,
    };

    expect(platformOf(loaded)).toEqual(mac);
  });
});

describe('redactSecrets and the observability redactor', () => {
  const secrets = SecretsSchema.parse({
    SMTP_PASSWORD: 'p@ss word&more',
    SLACK_WEBHOOK_URL: 'https://hooks.example.com/services/T000/B000/XXXX',
  });
  const values = Object.values(secrets);
  const encoded = encodeURIComponent('p@ss word&more');

  it('gives the same text as createRedactor for the same secret values', () => {
    const text = `a ${values[0]!} b ${encoded} c ${values[1]!} d "p@ss word&more" e`;

    expect(redactSecrets(text, secrets)).toBe(createRedactor(values).text(text));
  });

  it('also hides the percent-encoded form of a secret, as the logger does', () => {
    expect(redactSecrets(`GET /login?pw=${encoded}`, secrets)).toBe('GET /login?pw=[redacted]');
  });
});

describe('formatEnvValue', () => {
  it('leaves a plain value bare', () => {
    expect(formatEnvValue('K', 'http://localhost:11434')).toBe('http://localhost:11434');
  });

  it.each(['has space', 'a#b', 'a"b', "it's", 'back\\slash', '$HOME'])(
    'quotes %j so that the loader reads it back unchanged',
    (value) => {
      expect(parseEnv(`K=${formatEnvValue('K', value)}`)['K']).toBe(value);
    },
  );

  it.each(['a\nb', 'a\rb', `all ' " \` quotes`])(
    'refuses %j, which no quoting can hold',
    (value) => {
      expect(() => formatEnvValue('SECRET', value)).toThrow(/SECRET cannot be stored in \.env/);
    },
  );
});

describe('mergeEnvText', () => {
  const merge = (current: string, updates: { key: string; value: string }[]): string =>
    mergeEnvText(current, updates, '/work/.env');

  it('replaces a value in place and keeps comments, blank lines and other keys', () => {
    const current = '# note\n\nA=1\nB=old\nC=3\n';

    expect(merge(current, [{ key: 'B', value: 'new value' }])).toBe(
      "# note\n\nA=1\nB='new value'\nC=3\n",
    );
  });

  it('adds a missing key at the end, after a final newline that was missing', () => {
    expect(merge('A=1', [{ key: 'B', value: '2' }])).toBe('A=1\nB=2\n');
  });

  it('does not touch a commented-out key', () => {
    expect(merge('# B=old\nA=1\n', [{ key: 'B', value: '2' }])).toBe('# B=old\nA=1\nB=2\n');
  });

  it('does not match a longer key that merely starts with the same letters', () => {
    expect(merge('B_EXTRA=1\n', [{ key: 'B', value: '2' }])).toBe('B_EXTRA=1\nB=2\n');
  });

  it('keeps export and the spacing before the key', () => {
    expect(merge('  export  B =old\n', [{ key: 'B', value: '2' }])).toBe('  export  B=2\n');
  });

  it('returns the text unchanged, with a final newline, when there is nothing to set', () => {
    expect(merge('A=1', [])).toBe('A=1\n');
  });

  it('refuses a key that is not a variable name, so it never reaches a pattern', () => {
    expect(() => merge('A=1\n', [{ key: 'A.*', value: '2' }])).toThrow(/not a variable name/);
  });

  it('ends every line with CRLF, also the last one when the file had no final newline', () => {
    expect(merge('A=1\r\nB=2', [{ key: 'C', value: '3' }])).toBe('A=1\r\nB=2\r\nC=3\r\n');
    expect(merge('A=1\r\nB=2', [{ key: 'B', value: '9' }])).toBe('A=1\r\nB=9\r\n');
  });

  it('refuses to replace a value that spans several lines, which would leave its tail behind', () => {
    const current = 'B="line one\nline two"\nA=1\n';

    expect(() => merge(current, [{ key: 'B', value: '2' }])).toThrow(
      /Could not merge into \/work\/\.env safely: a setting init would change spans several lines/,
    );
  });

  it('refuses, naming the file, when a replaced line belongs to a multi-line value', () => {
    const current = 'NOTE="one\nB=inside"\n';

    expect(() => merge(current, [{ key: 'B', value: '2' }])).toThrow(
      /Could not merge into \/work\/\.env safely/,
    );
  });
});
