import { digestFilePaths } from '../../../delivery/adapters/markdownFile';
import type { RunResult } from '../../../digest/types';
import { pathExists } from '../../../shared/fsErrors';

/** The digest files in the local folder, as the summary lists them. */
export interface LocalFiles {
  markdown: string;
  /** Set only when the HTML copy is there. */
  html?: string;
}

/**
 * The local files of a run whose Markdown channel took the digest, or of a dry run that was
 * just written. The HTML copy is listed only when it is there: not every digest has a view.
 */
export async function localFilesOf(
  dir: string,
  result: RunResult,
  wroteDryRunCopy: boolean,
  variantSlug?: string,
): Promise<LocalFiles | undefined> {
  const { record } = result;
  const reached = wroteDryRunCopy || record.deliveredTo?.includes('markdown') === true;
  if (!reached) return undefined;
  const paths = digestFilePaths(dir, record.runId, variantSlug);
  const [hasMarkdown, hasHtml] = await Promise.all([
    isListable(paths.markdown),
    isListable(paths.html),
  ]);
  // A resumed week whose Markdown channel took the digest in an earlier run (and maybe another
  // folder) has nothing here: list what is there, not what the folder should hold.
  if (!hasMarkdown) return undefined;
  return hasHtml ? paths : { markdown: paths.markdown };
}

/**
 * Whether the summary may list the file. A path that cannot be checked (no access to the folder, a
 * link that loops) is left out: the summary is a courtesy and must not fail a finished run.
 */
function isListable(path: string): Promise<boolean> {
  return pathExists(path).catch(() => false);
}
