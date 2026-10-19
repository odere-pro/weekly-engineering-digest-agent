import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorCommand } from './doctor';
import type { DoctorIo } from './types';
import { harness, resultFor, type Setup } from './__fixtures__/doctorHarness';

describe('with the real file system', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-doctor-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const DISK_FUNCTIONS: ReadonlySet<string> = new Set(['stat', 'lstat', 'readFile', 'access']);

  /** Doctor with the real stat, lstat, readFile and access, and fakes for everything else. */
  async function doctorOnDisk(setup: Setup): Promise<{ code: number; text: string }> {
    const h = harness({ ...setup, envMode: null });
    const fakes = Object.entries(h.io).filter(([name]) => !DISK_FUNCTIONS.has(name));
    const io: Partial<DoctorIo> = { ...Object.fromEntries(fakes), envPath: join(dir, '.env') };
    const code = await doctorCommand({}, io);
    return { code, text: h.text() };
  }

  it('passes for a folder that exists and a missing one below it', async () => {
    await mkdir(join(dir, 'data'));

    const { code, text } = await doctorOnDisk({
      config: {
        dataDir: join(dir, 'data'),
        delivery: { markdown: { dir: join(dir, 'data', 'digests') } },
      },
    });

    expect(resultFor(text, '✓', 'data dir:')).toContain('is writable');
    expect(resultFor(text, '✓', 'markdown:')).toContain('does not exist yet');
    expect(code).toBe(0);
  });

  it('fails a dataDir that is a file', async () => {
    await writeFile(join(dir, 'data'), 'x');

    const { code, text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

    expect(code).toBe(1);
    expect(resultFor(text, '✗', 'data dir:')).toContain('is a file, not a folder');
  });

  it('fails a dataDir that is a dangling symbolic link', async () => {
    await symlink(join(dir, 'gone'), join(dir, 'data'));

    const { code, text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

    expect(code).toBe(1);
    expect(resultFor(text, '✗', 'data dir:')).toContain(
      'symbolic link to a path that does not exist',
    );
  });

  it('follows a symbolic link to a folder', async () => {
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'data'));

    const { text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

    expect(resultFor(text, '✓', 'data dir:')).toContain('is writable');
  });

  it('fails when a file sits on the way to the folder', async () => {
    await writeFile(join(dir, 'blocker'), 'x');

    const { text } = await doctorOnDisk({
      config: { dataDir: join(dir, 'blocker', 'data') },
    });

    expect(resultFor(text, '✗', 'data dir:')).toMatch(
      /is a file, so .* cannot be created below it/,
    );
  });

  it('warns about a value cut at "#" in the real .env, without printing it', async () => {
    await writeFile(join(dir, '.env'), 'GITHUB_TOKEN=ghp_secret#tail\n', { mode: 0o600 });
    await mkdir(join(dir, 'data'));

    const { text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

    expect(resultFor(text, '!', '.env values:')).toContain('GITHUB_TOKEN (line 1)');
    expect(resultFor(text, '✓', '.env:')).toContain('readable only by you');
    expect(text).not.toContain('ghp_secret');
  });

  it('says nothing about a missing .env beyond the .env check', async () => {
    const { text } = await doctorOnDisk({ config: { dataDir: dir } });

    expect(resultFor(text, '✓', '.env:')).toMatch(/no \.env file/i);
    expect(text).not.toContain('.env values');
  });
});
