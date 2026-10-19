import { describe, expect, it } from 'vitest';
import { diskIo, errnoError, type Setup } from '../__fixtures__/doctorHarness';
import { inspectDir, pathKind } from './inspectDir';

const DIR = '/srv/digest/data';

function io(setup: Setup = {}): ReturnType<typeof diskIo> {
  return diskIo({ existingDirs: ['/', '/srv', '/srv/digest'], ...setup });
}

describe('inspectDir', () => {
  it('is writable for an existing folder', async () => {
    const status = await inspectDir(
      DIR,
      'dataDir',
      io({ existingDirs: ['/', '/srv', '/srv/digest', DIR] }),
    );

    expect(status).toEqual({ kind: 'writable' });
  });

  it('is creatable, naming the nearest existing parent, when the folder is missing', async () => {
    expect(await inspectDir(DIR, 'dataDir', io())).toEqual({
      kind: 'creatable',
      parent: '/srv/digest',
    });
  });

  it('climbs past several missing levels to the first folder that exists', async () => {
    const status = await inspectDir('/srv/digest/a/b/c', 'dataDir', io());

    expect(status).toEqual({ kind: 'creatable', parent: '/srv/digest' });
  });

  it('blocks a folder that exists but cannot be written, with the chmod fix', async () => {
    const status = await inspectDir(
      DIR,
      'dataDir',
      io({ existingDirs: ['/', '/srv', '/srv/digest', DIR], readOnlyDirs: [DIR] }),
    );

    expect(status).toEqual({
      kind: 'blocked',
      problem: `cannot write to ${DIR}: EACCES: simulated`,
      fix: `make ${DIR} writable ("chmod u+w"), or set "dataDir" in digest.config.json`,
    });
  });

  it('blocks a missing folder whose nearest parent cannot be written', async () => {
    const status = await inspectDir(DIR, 'dataDir', io({ readOnlyDirs: ['/srv/digest'] }));

    expect(status.kind).toBe('blocked');
    expect(status.kind === 'blocked' && status.problem).toContain('/srv/digest');
  });

  it('blocks a file in place of the folder, and names the setting in the fix', async () => {
    const status = await inspectDir(
      DIR,
      'delivery.markdown.dir',
      io({ fs: { [DIR]: { kind: 'file' } } }),
    );

    expect(status).toEqual({
      kind: 'blocked',
      problem: `${DIR} is a file, not a folder`,
      fix: `remove or replace ${DIR}, or set "delivery.markdown.dir" in digest.config.json`,
    });
  });

  it('blocks a file higher up the path and names it as the culprit', async () => {
    const status = await inspectDir(
      DIR,
      'dataDir',
      io({ fs: { '/srv/digest': { kind: 'file' } } }),
    );

    expect(status).toMatchObject({
      kind: 'blocked',
      problem: `/srv/digest is a file, so ${DIR} cannot be created below it`,
      fix: `remove or replace /srv/digest, or set "dataDir" in digest.config.json`,
    });
  });

  it('blocks a dangling symbolic link', async () => {
    const status = await inspectDir(
      DIR,
      'dataDir',
      io({ fs: { [DIR]: { kind: 'symlink', target: '/gone' } } }),
    );

    expect(status).toMatchObject({
      kind: 'blocked',
      problem: `${DIR} is a symbolic link to a path that does not exist`,
    });
  });

  it('follows a symbolic link to a writable folder', async () => {
    const status = await inspectDir(
      DIR,
      'dataDir',
      io({ fs: { [DIR]: { kind: 'symlink', target: '/mnt/data' }, '/mnt/data': { kind: 'dir' } } }),
    );

    expect(status).toEqual({ kind: 'writable' });
  });

  it('blocks when nothing on the path exists, root included', async () => {
    const status = await inspectDir(DIR, 'dataDir', io({ existingDirs: [] }));

    expect(status).toMatchObject({
      kind: 'blocked',
      problem: `${DIR} does not exist and has no existing parent`,
    });
  });

  it('blocks, with the reason, when a path cannot be inspected', async () => {
    const failing = {
      ...io(),
      lstat: async () => {
        throw errnoError('EIO');
      },
    };

    const status = await inspectDir(DIR, 'dataDir', failing);

    expect(status).toMatchObject({
      kind: 'blocked',
      problem: `cannot inspect ${DIR}: EIO: simulated`,
    });
  });
});

describe('pathKind', () => {
  it('tells a folder, a file and a missing path apart', async () => {
    const disk = io({ fs: { '/srv/file': { kind: 'file' } } });

    expect(await pathKind('/srv', disk)).toBe('folder');
    expect(await pathKind('/srv/file', disk)).toBe('file');
    expect(await pathKind('/srv/none', disk)).toBe('missing');
  });

  it('follows a symbolic link to a file or a folder, and calls a broken one dangling', async () => {
    const disk = io({
      fs: {
        '/srv/to-file': { kind: 'symlink', target: '/srv/file' },
        '/srv/file': { kind: 'file' },
        '/srv/to-dir': { kind: 'symlink', target: '/srv/digest' },
        '/srv/broken': { kind: 'symlink', target: '/nowhere' },
      },
    });

    expect(await pathKind('/srv/to-file', disk)).toBe('file');
    expect(await pathKind('/srv/to-dir', disk)).toBe('folder');
    expect(await pathKind('/srv/broken', disk)).toBe('dangling');
  });

  it('reads ENOTDIR from lstat as missing: a parent is a file, and climbing finds it', async () => {
    const disk = {
      ...io(),
      lstat: async () => {
        throw errnoError('ENOTDIR');
      },
    };

    expect(await pathKind('/srv/file/below', disk)).toBe('missing');
  });

  it('rethrows any other lstat error', async () => {
    const disk = {
      ...io(),
      lstat: async () => {
        throw errnoError('EIO');
      },
    };

    await expect(pathKind('/srv', disk)).rejects.toThrow('EIO');
  });

  it('rethrows a stat error on a link that is not ENOENT', async () => {
    const disk = {
      ...io({ fs: { '/srv/link': { kind: 'symlink', target: '/srv' } } }),
      stat: async () => {
        throw errnoError('EACCES');
      },
    };

    await expect(pathKind('/srv/link', disk)).rejects.toThrow('EACCES');
  });
});
