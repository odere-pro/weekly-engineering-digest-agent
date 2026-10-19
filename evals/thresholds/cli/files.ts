// The files the commands read and write: raw captures in, raw captures and tuning results out.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import { DigestError, errorMessage } from '../../../src/shared/errors';
import { RawCaptureSchema, type RawCapture } from '../capture/schemas';

/** The local calendar date of an instant, as YYYY-MM-DD; names the capture and sweep files. */
export function localDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Writes `value` as JSON formatted the way the repo's prettier config formats it. With
 * `overwrite: false` an existing file is an error, never replaced.
 */
export async function writeJson(path: string, value: unknown, overwrite = true): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  await mkdir(dirname(path), { recursive: true });
  const text = await format(JSON.stringify(value), { ...options, filepath: path });
  await writeFile(path, text, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
}

/** Fails before any model call when the capture would replace an earlier one. */
export async function assertNew(path: string): Promise<void> {
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new DigestError(`${path} exists; pass --force to replace it, or move it away first`);
}

/** A raw capture file, checked against its schema. */
export async function readRaw(path: string): Promise<RawCapture> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = RawCaptureSchema.safeParse(json);
  if (!parsed.success)
    throw new DigestError(`${path} is not a raw capture:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
