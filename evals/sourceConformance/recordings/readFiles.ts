import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { DigestError, errorMessage } from '../../../src/shared/errors';
import { errnoCode } from '../../../src/shared/fsErrors';

/** A JSON file read and checked against its schema; the error names the file. */
export async function readParsed<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(`${path} does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The names of the sub-folders of `dir`, sorted. A missing `dir` has none. */
export async function folderNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw new DigestError(`Cannot read ${dir}: ${errorMessage(error)}`, { cause: error });
  }
}
