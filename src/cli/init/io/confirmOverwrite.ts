import { DigestError } from '../../../shared/errors';
import type { InitIo } from '../types';

/**
 * Stops init before it replaces a file with content. Interactively it asks (default no); under
 * `--yes` it refuses, because nobody is there to say yes. An empty file is as good as none:
 * Docker needs the files to exist before the first run.
 */
export async function confirmOverwrite(paths: string[], yes: boolean, io: InitIo): Promise<void> {
  const present = await Promise.all(
    paths.map(async (path) => ((await hasContent(path, io)) ? path : '')),
  );
  const existing = present.filter((path) => path !== '');
  if (existing.length === 0) return;

  const list = existing.join(' and ');
  if (yes) {
    throw new DigestError(
      `Refusing to overwrite ${list} with --yes. Move it away, or run "digest init" without --yes to confirm.`,
    );
  }
  const overwrite = await io.prompts.confirm({ message: `Overwrite ${list}?`, default: false });
  if (!overwrite) throw new DigestError(`Kept ${list}. Nothing was written.`);
}

async function hasContent(path: string, io: InitIo): Promise<boolean> {
  return (await io.exists(path)) && !(await io.isEmptyFile(path));
}
