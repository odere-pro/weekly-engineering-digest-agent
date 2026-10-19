import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { weekDigestDir } from '../../../src/store/layout';
import { RunRecordSchema, type RunRecord } from '../../../src/store/runRecord';

export function runFile(dataDir: string, weekId: string, name: string): string {
  return join(weekDigestDir(dataDir, weekId), name);
}

function isNoEntry(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNoEntry(error)) return undefined;
    throw error;
  }
}

/** The week's run.json as the run store wrote it, parsed with the real schema. */
export async function readRunJson(dataDir: string, weekId: string): Promise<RunRecord> {
  const text = await readTextIfExists(runFile(dataDir, weekId, 'run.json'));
  if (text === undefined) throw new Error(`No run.json for ${weekId} under ${dataDir}`);
  return RunRecordSchema.parse(JSON.parse(text));
}
