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
import type * as Fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSecretFile } from './secretFile';

// Real files, except that a test can make rename or chmod fail like a bind mount does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, rename: vi.fn(actual.rename), chmod: vi.fn(actual.chmod) };
});

const BIND_MOUNT_CODES = ['EBUSY', 'EXDEV', 'EACCES', 'EPERM'];
/** Readable by the group (a DIGEST_GID mount), by others, and by both. */
const LEAKY_MODES = [0o644, 0o640, 0o604, 0o660].map((mode) => [mode.toString(8), mode] as const);
const isRoot = process.getuid?.() === 0;

describe('writeSecretFile', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-init-secret-'));
    path = join(dir, '.env');
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
  const modeOf = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;
  const leftovers = async (): Promise<string[]> =>
    (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

  describe('where a rename works', () => {
    it('writes a new file with mode 0600 through a temp file and a rename', async () => {
      await writeSecretFile(path, 'SMTP_PASSWORD=secret\n');

      expect(await readFile(path, 'utf8')).toBe('SMTP_PASSWORD=secret\n');
      expect(await modeOf(path)).toBe(0o600);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rename).mock.calls[0]?.[1]).toBe(path);
      expect(vi.mocked(rename).mock.calls[0]?.[0]).not.toBe(path);
      expect(await leftovers()).toEqual([]);
    });

    it('replaces a world-readable file with an owner-only one, as a new file', async () => {
      await writeFile(path, 'SMTP_PASSWORD=old\n');
      await chmod(path, 0o644);
      const before = await stat(path);

      await writeSecretFile(path, 'SMTP_PASSWORD=new\n');

      expect(await readFile(path, 'utf8')).toBe('SMTP_PASSWORD=new\n');
      expect((await stat(path)).ino).not.toBe(before.ino);
      expect(await modeOf(path)).toBe(0o600);
      expect(await leftovers()).toEqual([]);
    });

    it('keeps the temp name next to the target, so the rename stays on one file system', async () => {
      await writeSecretFile(path, 'A=1\n');

      const temp = String(vi.mocked(rename).mock.calls[0]?.[0]);
      expect(temp.startsWith(`${path}.`)).toBe(true);
      expect(temp.endsWith('.tmp')).toBe(true);
    });
  });

  describe('where the file is a single-file bind mount', () => {
    it.each(BIND_MOUNT_CODES)('writes in place when the rename fails with %s', async (code) => {
      await writeFile(path, '', { mode: 0o600 });
      const before = await stat(path);
      vi.mocked(rename).mockRejectedValueOnce(errnoError(code));

      await writeSecretFile(path, 'OLLAMA_URL=http://localhost:11434\n');

      const after = await stat(path);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      expect(await readFile(path, 'utf8')).toBe('OLLAMA_URL=http://localhost:11434\n');
      expect(await leftovers()).toEqual([]);
    });

    it.each(LEAKY_MODES)(
      'tightens a file with mode %s before the secrets go into it',
      async (_label, mode) => {
        await writeFile(path, 'SMTP_PASSWORD=old\n');
        await chmod(path, mode);
        vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));

        await writeSecretFile(path, 'SMTP_PASSWORD=new\n');

        expect(await modeOf(path)).toBe(0o600);
        expect(await readFile(path, 'utf8')).toBe('SMTP_PASSWORD=new\n');
      },
    );

    it('accepts a chmod that is refused when the file is already owner-only', async () => {
      await writeFile(path, '', { mode: 0o600 });
      vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
      vi.mocked(chmod).mockRejectedValueOnce(errnoError('EPERM'));

      await writeSecretFile(path, 'A=1\n');

      expect(await readFile(path, 'utf8')).toBe('A=1\n');
    });

    it.each(LEAKY_MODES)(
      'writes nothing into a file with mode %s that it cannot tighten, and says what to do',
      async (_label, mode) => {
        await writeFile(path, '');
        await chmod(path, mode);
        vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
        vi.mocked(chmod).mockRejectedValueOnce(errnoError('EPERM'));

        const failure = await writeSecretFile(path, 'SMTP_PASSWORD=secret\n').catch(
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain(path);
        expect(message).toMatch(/DIGEST_UID.*DIGEST_GID/);
        expect(message).not.toContain('SMTP_PASSWORD');
        expect(await readFile(path, 'utf8')).toBe('');
      },
    );

    it.each(LEAKY_MODES)(
      'writes nothing when chmod says yes but a file with mode %s stays readable',
      async (_label, mode) => {
        await writeFile(path, '');
        await chmod(path, mode);
        vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));
        vi.mocked(chmod).mockResolvedValueOnce(undefined);

        await expect(writeSecretFile(path, 'SMTP_PASSWORD=secret\n')).rejects.toThrow(
          'still readable by others',
        );
        expect(await readFile(path, 'utf8')).toBe('');
      },
    );

    it('creates the file, owner-only, when the rename fails and there is nothing to restrict', async () => {
      vi.mocked(rename).mockRejectedValueOnce(errnoError('EBUSY'));

      await writeSecretFile(path, 'A=1\n');

      expect(await readFile(path, 'utf8')).toBe('A=1\n');
      expect(await modeOf(path)).toBe(0o600);
    });
  });

  describe('when the failure is not about a bind mount', () => {
    it('does not fall back for another system error, and keeps the old file', async () => {
      await writeFile(path, 'KEEP=me\n', { mode: 0o600 });
      vi.mocked(rename).mockRejectedValueOnce(errnoError('ENOSPC'));

      await expect(writeSecretFile(path, 'A=1\n')).rejects.toThrow('ENOSPC');

      expect(await readFile(path, 'utf8')).toBe('KEEP=me\n');
      expect(await leftovers()).toEqual([]);
    });

    it('does not fall back for an error with no code', async () => {
      await writeFile(path, 'KEEP=me\n', { mode: 0o600 });
      vi.mocked(rename).mockRejectedValueOnce(new Error('boom'));

      await expect(writeSecretFile(path, 'A=1\n')).rejects.toThrow('boom');

      expect(await readFile(path, 'utf8')).toBe('KEEP=me\n');
    });

    it('leaves no temp file behind when the destination cannot be replaced', async () => {
      await mkdir(path);

      await expect(writeSecretFile(path, 'A=1\n')).rejects.toThrow();

      expect(await leftovers()).toEqual([]);
    });
  });

  describe.skipIf(isRoot)('in a read-only folder, as /app is for the node user', () => {
    it('writes the existing file in place', async () => {
      await writeFile(path, '', { mode: 0o600 });
      await chmod(dir, 0o555);

      await writeSecretFile(path, 'A=1\n');

      expect(await readFile(path, 'utf8')).toBe('A=1\n');
      expect(await modeOf(path)).toBe(0o600);
    });

    it('fails when there is no file to write in place', async () => {
      await chmod(dir, 0o555);

      await expect(writeSecretFile(path, 'A=1\n')).rejects.toThrow();

      expect(await readdir(dir)).toEqual([]);
    });
  });
});
