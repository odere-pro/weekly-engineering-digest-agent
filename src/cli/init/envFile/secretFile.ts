import { randomUUID } from 'node:crypto';
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises';
import { errorMessage } from '../../../shared/errors';
import { errorCode } from '../../doctor/errorCode';

const SECRET_FILE_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const OWNER_ONLY_HINT =
  'Run "chmod 600" on it on the host, or set DIGEST_UID and DIGEST_GID to your user (see docker-compose.yml).';
/** A rename onto these fails when the target is a bind mount or its folder is not writable. */
const IN_PLACE_FALLBACK_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EXDEV', 'EACCES', 'EPERM']);

/**
 * Writes `content` to a file only its owner can read. The temp file and rename keep readers from
 * seeing half a file; where the rename cannot work (the file is a single-file bind mount, the
 * folder is read-only) the existing file is written in place instead.
 */
export async function writeSecretFile(path: string, content: string): Promise<void> {
  try {
    await writeViaTempFile(path, content);
  } catch (error) {
    if (!IN_PLACE_FALLBACK_CODES.has(errorCode(error) ?? '')) throw error;
    await writeInPlace(path, content);
  }
}

/** Creates the file with mode 0600 under a temp name, then renames it over `path`: never readable by others. */
async function writeViaTempFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: SECRET_FILE_MODE, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeInPlace(path: string, content: string): Promise<void> {
  await restrictToOwner(path);
  // The mode only applies to a file this call creates.
  await writeFile(path, content, { encoding: 'utf8', mode: SECRET_FILE_MODE });
}

/**
 * Makes an existing file owner-only before secrets go into it. A mount that refuses chmod is
 * fine if the file already is owner-only; a chmod that did nothing is not. Otherwise nothing is
 * written.
 */
async function restrictToOwner(path: string): Promise<void> {
  try {
    await chmod(path, SECRET_FILE_MODE);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    if (await isOwnerOnly(path)) return;
    throw new Error(
      `${path} is readable by others and cannot be restricted (${errorMessage(error)}). ${OWNER_ONLY_HINT}`,
      { cause: error },
    );
  }
  if (!(await isOwnerOnly(path))) {
    throw new Error(`${path} is still readable by others after chmod. ${OWNER_ONLY_HINT}`);
  }
}

async function isOwnerOnly(path: string): Promise<boolean> {
  const { mode } = await stat(path);
  return (mode & GROUP_AND_OTHER_BITS) === 0;
}
