import { join } from 'node:path';
import { readTextIfExists } from '../../../src/shared/atomicFile';
import { weekDigestDir } from '../../../src/store/layout';
import { RunRecordSchema, type RunRecord } from '../../../src/store/runRecord';

export function runFile(dataDir: string, weekId: string, name: string): string {
  return join(weekDigestDir(dataDir, weekId), name);
}

/** The week's run.json as the run store wrote it, parsed with the real schema. */
export async function readRunJson(dataDir: string, weekId: string): Promise<RunRecord> {
  const text = await readTextIfExists(runFile(dataDir, weekId, 'run.json'));
  if (text === undefined) throw new Error(`No run.json for ${weekId} under ${dataDir}`);
  return RunRecordSchema.parse(JSON.parse(text));
}
