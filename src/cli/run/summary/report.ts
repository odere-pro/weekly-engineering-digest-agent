import { markdownFileOptions, markdownFolder } from '../../../delivery/adapters/markdownFile';
import type { LoadedConfig } from '../../../config/load';
import type { RunResult } from '../../../digest/types';
import { variantSlug, type RunVariant } from '../../../digest/variant';
import type { LocalCopy } from './localCopy';
import { localFilesOf } from './localFiles';
import { printSummary, type Reporter } from './summary';

/** Prints the summary with the local files of the run (or of its variant). Returns the digest folder. */
export async function reportRun(
  report: Reporter,
  loaded: LoadedConfig,
  result: RunResult,
  copy: LocalCopy,
  variant?: RunVariant,
): Promise<string> {
  const dir = markdownFolder(markdownFileOptions(loaded.config), result.record.runId);
  const slug = variant ? variantSlug(variant) : undefined;
  const files = await localFilesOf(dir, result, copy.written, slug);
  printSummary(report, loaded, result, files, variant);
  return dir;
}
