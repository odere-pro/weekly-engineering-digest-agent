import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorCommand } from '../doctor';
import {
  DATA_DIR,
  diskIo,
  errnoError,
  harness,
  resultFor,
  runDoctor,
} from '../__fixtures__/doctorHarness';
import { checkWritableDir, dataDirCheck, markdownDirCheck } from './writableDir';

describe('dataDirCheck and markdownDirCheck', () => {
  it('resolve a relative folder against the working directory', () => {
    expect(dataDirCheck('rel/data').dir).toBe(join(process.cwd(), 'rel/data'));
    expect(markdownDirCheck('dist/digests').dir).toBe(join(process.cwd(), 'dist/digests'));
  });

  it('name the folder and the config key that moves it', () => {
    expect(dataDirCheck('/d')).toMatchObject({ label: 'data dir', setting: 'dataDir' });
    expect(markdownDirCheck('/m')).toMatchObject({
      label: 'markdown',
      setting: 'delivery.markdown.dir',
    });
  });

  it('word the messages for a writable and a creatable folder', () => {
    const data = dataDirCheck('/srv/data');
    const markdown = markdownDirCheck('/srv/md');

    expect(data.writable).toBe('/srv/data is writable');
    expect(data.creatable('/srv')).toBe(
      '/srv/data does not exist yet; /srv is writable, so a run creates it',
    );
    expect(markdown.writable).toBe('digests are written to /srv/md');
    expect(markdown.creatable('/srv')).toBe(
      'digests are written to /srv/md, which does not exist yet; /srv is writable, so a run creates it',
    );
  });
});

describe('checkWritableDir', () => {
  const io = diskIo({ existingDirs: ['/', '/srv', DATA_DIR], readOnlyDirs: ['/ro'] });

  it('is ok with the writable message for an existing folder', async () => {
    expect(await checkWritableDir(dataDirCheck(DATA_DIR), io)).toEqual({
      severity: 'ok',
      label: 'data dir',
      message: `${DATA_DIR} is writable`,
    });
  });

  it('is ok with the creatable message, naming the parent, for a missing folder', async () => {
    const result = await checkWritableDir(dataDirCheck('/srv/new'), io);

    expect(result).toMatchObject({
      severity: 'ok',
      message: '/srv/new does not exist yet; /srv is writable, so a run creates it',
    });
  });

  it('fails with the problem and the fix when the folder is blocked', async () => {
    const result = await checkWritableDir(markdownDirCheck('/ro'), io);

    expect(result.severity).toBe('error');
    expect(result.label).toBe('markdown');
    expect(result.fix).toContain('"delivery.markdown.dir"');
  });
});

describe('doctor folder checks', () => {
  describe('data directory', () => {
    it('prints ✗ with a fix when dataDir exists but is not writable', async () => {
      const { code, text } = await runDoctor({ readOnlyDirs: [DATA_DIR] });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(new RegExp(`${DATA_DIR}.*\\n\\s+fix: `));
    });

    it('prints ✓ when dataDir does not exist yet but its parent is writable', async () => {
      const { code, text } = await runDoctor({ existingDirs: ['/', '/srv', '/srv/digest'] });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'data dir:')).toMatch(/created|does not exist yet/i);
    });

    it('prints ✗ when dataDir does not exist and the nearest existing parent is read-only', async () => {
      const { code, text } = await runDoctor({
        existingDirs: ['/', '/srv', '/srv/digest'],
        readOnlyDirs: ['/srv/digest'],
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain('/srv/digest');
    });

    it('prints ✗ when no parent exists at all', async () => {
      const { code, text } = await runDoctor({ existingDirs: [] });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toBeDefined();
    });

    it('prints ✗ when dataDir is a file, even a writable one', async () => {
      const { code, text } = await runDoctor({ fs: { [DATA_DIR]: { kind: 'file' } } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        new RegExp(`${DATA_DIR} is a file, not a folder.*\\n\\s+fix: .*"dataDir"`),
      );
    });

    it('prints ✗ when dataDir is a dangling symbolic link, which a run cannot create', async () => {
      const { code, text } = await runDoctor({
        fs: { [DATA_DIR]: { kind: 'symlink', target: '/mnt/gone/data' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        new RegExp(`${DATA_DIR} is a symbolic link to a path that does not exist`),
      );
    });

    it('prints ✗ when dataDir is a symbolic link to a file', async () => {
      const { code, text } = await runDoctor({
        fs: { [DATA_DIR]: { kind: 'symlink', target: '/srv/file' }, '/srv/file': { kind: 'file' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain('is a file, not a folder');
    });

    it('prints ✓ when dataDir is a symbolic link to a writable folder', async () => {
      const { code, text } = await runDoctor({
        fs: {
          [DATA_DIR]: { kind: 'symlink', target: '/mnt/data' },
          '/mnt/data': { kind: 'dir' },
        },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'data dir:')).toContain(`${DATA_DIR} is writable`);
    });

    it('prints ✗ when a symbolic link to a folder is not writable', async () => {
      const { text } = await runDoctor({
        fs: {
          [DATA_DIR]: { kind: 'symlink', target: '/mnt/data' },
          '/mnt/data': { kind: 'dir', writable: false },
        },
      });

      expect(resultFor(text, '✗', 'data dir:')).toContain('cannot write');
    });

    it('prints ✗ when the nearest existing parent is a file, so dataDir cannot be created', async () => {
      const { code, text } = await runDoctor({
        config: { dataDir: '/srv/blocked/data' },
        fs: { '/srv/blocked': { kind: 'file' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        /\/srv\/blocked is a file, so \/srv\/blocked\/data cannot be created below it/,
      );
    });

    it('prints ✗ when a parent is a dangling symbolic link', async () => {
      const { text } = await runDoctor({
        config: { dataDir: '/srv/link/data' },
        fs: { '/srv/link': { kind: 'symlink', target: '/nowhere' } },
      });

      expect(resultFor(text, '✗', 'data dir:')).toContain('/srv/link is a symbolic link');
    });

    it('names the file when lstat answers ENOTDIR for the path below it', async () => {
      const h = harness({ config: { dataDir: '/srv/file/data/deeper' } });
      h.io.lstat = async (path) => {
        if (path === '/srv/file')
          return { mode: 0o100644, isDirectory: false, isSymbolicLink: false };
        throw errnoError(path.startsWith('/srv/file/') ? 'ENOTDIR' : 'ENOENT');
      };

      const code = await doctorCommand({}, h.io);

      expect(code).toBe(1);
      expect(resultFor(h.text(), '✗', 'data dir:')).toMatch(
        /\/srv\/file is a file, so \/srv\/file\/data\/deeper cannot be created below it.*\n\s+fix: remove or replace \/srv\/file,/,
      );
    });

    it('prints ✗ with the reason when the path cannot be inspected', async () => {
      const h = harness();
      h.io.lstat = async () => {
        throw errnoError('EIO');
      };

      const code = await doctorCommand({}, h.io);

      expect(code).toBe(1);
      expect(resultFor(h.text(), '✗', 'data dir:')).toMatch(/cannot inspect.*EIO/);
    });

    it('resolves a relative dataDir against the working directory', async () => {
      const h = harness({ config: { dataDir: 'rel/data' } });
      const seen: string[] = [];
      const lstat = h.io.lstat!;
      h.io.lstat = async (path) => {
        seen.push(path);
        return lstat(path);
      };

      await doctorCommand({}, h.io);

      expect(seen).toContain(join(process.cwd(), 'rel/data'));
    });
  });

  describe('markdown directory', () => {
    const MARKDOWN_DIR = '/srv/digest/data/digests';
    const withDir = { delivery: { markdown: { dir: MARKDOWN_DIR } } } as const;

    it('prints ✓ naming the folder when it exists and is writable', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'dir' } },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'markdown:')).toContain(`digests are written to ${MARKDOWN_DIR}`);
    });

    it('prints ✓ when it does not exist yet but a parent is writable', async () => {
      const { code, text } = await runDoctor({ config: withDir });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'markdown:')).toMatch(
        /does not exist yet; \/srv\/digest\/data is writable, so a run creates it/,
      );
    });

    it('prints ✗ with a fix naming the setting when the folder is read-only', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'dir', writable: false } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'markdown:')).toMatch(
        new RegExp(`cannot write to ${MARKDOWN_DIR}.*\\n\\s+fix: .*"delivery.markdown.dir"`),
      );
    });

    it('prints ✗ when the folder does not exist and its nearest parent is read-only', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [DATA_DIR]: { kind: 'dir', writable: false } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'markdown:')).toContain(DATA_DIR);
    });

    it('prints ✗ when it is a file', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'file' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'markdown:')).toContain(
        `${MARKDOWN_DIR} is a file, not a folder`,
      );
    });

    it('prints ✗ when it is a dangling symbolic link', async () => {
      const { text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'symlink', target: '/mnt/gone' } },
      });

      expect(resultFor(text, '✗', 'markdown:')).toContain(
        'symbolic link to a path that does not exist',
      );
    });

    it("says the digests go to each week's folder in the data folder when no folder is set", async () => {
      const { code, text } = await runDoctor({});

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'markdown:')).toContain(
        `digests are written to each week's folder in ${DATA_DIR}`,
      );
    });

    it('resolves a relative folder against the working directory', async () => {
      const h = harness({ config: { delivery: { markdown: { dir: 'out/digests' } } } });
      const seen: string[] = [];
      const lstat = h.io.lstat!;
      h.io.lstat = async (path) => {
        seen.push(path);
        return lstat(path);
      };

      await doctorCommand({}, h.io);

      expect(seen).toContain(join(process.cwd(), 'out/digests'));
    });
  });
});
