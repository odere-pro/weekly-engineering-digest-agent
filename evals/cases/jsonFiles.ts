import { readdir, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { DigestError, errorMessage } from '../../src/shared/errors';

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** undefined when the file does not exist; a DigestError that names the file when it is bad. */
export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DigestError(`${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(`${path} does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function requireJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const value = await readJson(path, schema);
  if (value === undefined) throw new DigestError(`${path} is missing`);
  return value;
}

/** Throws a DigestError when `path` is not there; `hint` is added to the "not found" message. */
export async function requireFolder(path: string, hint?: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    const missing = hint === undefined ? 'not found' : `not found. ${hint}`;
    const reason = isNotFound(error) ? missing : errorMessage(error);
    throw new DigestError(`Eval folder ${path}: ${reason}`, { cause: error });
  }
}

/** Sorted names in `dir`; empty when the folder does not exist. */
export async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new DigestError(`Cannot read ${dir}: ${errorMessage(error)}`, { cause: error });
  }
}
