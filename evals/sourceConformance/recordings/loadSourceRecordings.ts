import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Source } from '../../../src/domain/schemas';
import { DigestError, errorMessage } from '../../../src/shared/errors';
import { DEFAULT_SOURCES } from '../../../src/sources/defaultSources';
import { SourceExpectedSchema, SourceResponseSchema, type SourceResponse } from '../../schema';
import { loadPages } from './loadPages';
import { folderNames, readParsed } from './readFiles';
import type { SourceRecording } from './types';

async function loadOne(
  dir: string,
  source: Source,
  response: SourceResponse,
  bodyFile: string,
): Promise<SourceRecording> {
  if (basename(bodyFile) !== bodyFile) {
    throw new DigestError(
      `${join(dir, 'response.json')}: bodyFile "${bodyFile}" leaves the folder`,
    );
  }
  const body = await readFile(join(dir, bodyFile), 'utf8').catch((error: unknown) => {
    throw new DigestError(`Cannot read ${join(dir, bodyFile)}: ${errorMessage(error)}`, {
      cause: error,
    });
  });
  const expected = await readParsed(join(dir, 'expected.json'), SourceExpectedSchema);
  return { source, response, body, pages: await loadPages(dir, expected), expected };
}

/**
 * Every recording under `dir` (one folder per source id). A folder whose recording failed (an
 * error and no body) has nothing to check and is skipped. A missing `dir` is an empty set.
 */
export async function loadSourceRecordings(
  dir: string,
  sources: readonly Source[] = DEFAULT_SOURCES,
): Promise<SourceRecording[]> {
  const recordings: SourceRecording[] = [];
  for (const id of await folderNames(dir)) {
    const folder = join(dir, id);
    const source = sources.find((candidate) => candidate.id === id);
    if (!source) throw new DigestError(`${folder}: "${id}" is not a known source id`);
    const response = await readParsed(join(folder, 'response.json'), SourceResponseSchema);
    if (response.error !== undefined || response.bodyFile === undefined) continue;
    recordings.push(await loadOne(folder, source, response, response.bodyFile));
  }
  return recordings;
}
