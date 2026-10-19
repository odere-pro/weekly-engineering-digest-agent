// `sweep`: picks the thresholds from a saved raw capture, offline, and saves the result.
import { join } from 'node:path';
import { summaryText } from '../result/summary';
import { tuneThresholds } from '../result/tune';
import { defaultSplit } from '../split';
import { localDate, readRaw, writeJson } from './files';
import { EXIT_OK, type CliIo } from './io';

/** `holdout` lists the held-out weeks; undefined keeps the default (the two newest). */
export async function sweepCommand(
  rawPath: string,
  holdout: readonly string[] | undefined,
  io: CliIo,
): Promise<number> {
  const raw = await readRaw(rawPath);
  const split =
    holdout === undefined ? defaultSplit(raw) : { ...defaultSplit(raw), holdoutWeeks: holdout };
  const result = tuneThresholds(raw, split);
  const path = join(io.outDir, `${localDate(raw.capturedAt)}-${raw.profile}.json`);
  await writeJson(path, result);
  io.stdout(`${summaryText(result)}\nSaved ${path}\n`);
  return EXIT_OK;
}
