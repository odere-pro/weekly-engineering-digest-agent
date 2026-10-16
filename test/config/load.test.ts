import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, redactSecrets, type LoadOptions } from '../../src/config/load.js';
import { NON_MAC_FALLBACK, PROFILES } from '../../src/config/profiles.js';
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
