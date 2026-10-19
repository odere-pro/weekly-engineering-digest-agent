import { dirname } from 'node:path';
import { errorMessage } from '../../../shared/errors';
import { errorCode, isNotFound } from '../errorCode';
import type { DoctorIo, PathInfo } from '../types';

export type DirIo = Pick<DoctorIo, 'stat' | 'lstat' | 'access'>;

/** What the folder a run writes into looks like from here. */
export type DirStatus =
  | { kind: 'writable' }
  | { kind: 'creatable'; parent: string }
  | { kind: 'blocked'; problem: string; fix: string };

/** What is at a path, following a symbolic link to what it points at. */
export type PathKind = 'folder' | 'file' | 'dangling' | 'missing';

/**
 * A missing folder is fine when the nearest existing parent is writable: the run creates it. A
 * file or a dangling symbolic link in its place is not (mkdir fails), and neither is a file
 * further up the path. `dir` is absolute; `setting` is the config key that moves it.
 */
export async function inspectDir(dir: string, setting: string, io: DirIo): Promise<DirStatus> {
  const permissionFix = `make ${dir} writable ("chmod u+w"), or set "${setting}" in digest.config.json`;
  const blocked = (problem: string, culprit?: string): DirStatus => ({
    kind: 'blocked',
    problem,
    fix:
      culprit === undefined
        ? permissionFix
        : `remove or replace ${culprit}, or set "${setting}" in digest.config.json`,
  });
  for (let current = dir; ; current = dirname(current)) {
    let kind: PathKind;
    try {
      kind = await pathKind(current, io);
    } catch (error) {
      return blocked(`cannot inspect ${current}: ${errorMessage(error)}`);
    }
    switch (kind) {
      case 'folder':
        return writableStatus(current, dir, io, blocked);
      case 'file':
        return blocked(
          current === dir
            ? `${dir} is a file, not a folder`
            : `${current} is a file, so ${dir} cannot be created below it`,
          current,
        );
      case 'dangling':
        return blocked(`${current} is a symbolic link to a path that does not exist`, current);
      case 'missing':
        if (dirname(current) === current) {
          return blocked(`${dir} does not exist and has no existing parent`);
        }
    }
  }
}

/** `folder` is the existing folder found: `dir` itself, or its nearest existing parent. */
async function writableStatus(
  folder: string,
  dir: string,
  io: Pick<DirIo, 'access'>,
  blocked: (problem: string) => DirStatus,
): Promise<DirStatus> {
  try {
    await io.access(folder);
  } catch (error) {
    return blocked(`cannot write to ${folder}: ${errorMessage(error)}`);
  }
  return folder === dir ? { kind: 'writable' } : { kind: 'creatable', parent: folder };
}

export async function pathKind(path: string, io: Pick<DirIo, 'stat' | 'lstat'>): Promise<PathKind> {
  let info: PathInfo;
  try {
    info = await io.lstat(path);
  } catch (error) {
    // ENOTDIR: a parent is a file. Climbing on finds it, so the message can name it.
    if (isNotFound(error) || errorCode(error) === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (!info.isSymbolicLink) return info.isDirectory ? 'folder' : 'file';
  try {
    return (await io.stat(path)).isDirectory ? 'folder' : 'file';
  } catch (error) {
    if (isNotFound(error)) return 'dangling';
    throw error;
  }
}
