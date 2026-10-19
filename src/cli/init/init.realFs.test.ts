// `initCommand` on a real folder: the config the loader accepts, the owner-only .env, and the
// single-file bind mounts of Docker (a rename that fails, a read-only folder).
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/load';
import { SecretsSchema } from '../../config/schema';
import { DEFAULT_FOCUS_AREAS } from '../../sources/defaultSources';
import {
  EMAIL_RULES,
  GIB,
  SCHEDULE,
  scriptedPrompts,
  SLACK_RULES,
  type Rule,
} from './__fixtures__/initHarness';
import { initCommand } from './init';
import type { InitIo } from './types';

// Real files, except that a test can make rename or chmod fail like a bind mount does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, rename: vi.fn(actual.rename), chmod: vi.fn(actual.chmod) };
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
    await writeFile(envPath, 'SMTP_PASSWORD=old\n');
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
    await writeFile(envPath, 'SMTP_PASSWORD=old\n');
    await chmod(envPath, 0o644);
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
    await writeFile(join(dir, '.env'), 'GITHUB_TOKEN=ghp_keep\nLOG_LEVEL=debug\n');
    await chmod(join(dir, '.env'), 0o644);

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
});
