import { writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import { errnoCode } from '../../../src/shared/fsErrors';

/** Creates `path` only when it does not exist yet; true when this call created it. */
export async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw error;
  }
}

/** `value` as JSON text in the repo's prettier format. */
export function toJson(path: string, value: unknown): Promise<string> {
  return formatLikeRepo(path, JSON.stringify(value, null, 2));
}

/** Formats with the repo's prettier config, so committed recordings pass `pnpm format:check`. */
export async function formatLikeRepo(path: string, content: string): Promise<string> {
  const options = await resolveConfig(path);
  return format(content, { ...options, filepath: path });
}
