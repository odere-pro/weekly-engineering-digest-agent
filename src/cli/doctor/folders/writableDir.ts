import { resolve } from 'node:path';
import { fail, ok, type CheckResult } from '../report/checkResult';
import { inspectDir, type DirIo } from './inspectDir';

/** A folder a run writes into, and the words to say about it. */
export interface DirCheck {
  label: string;
  /** Absolute. */
  dir: string;
  /** The config key that moves it, named in the fix. */
  setting: string;
  /** The message when the folder exists and is writable. */
  writable: string;
  /** The message when it is missing but `parent` is writable, so a run creates it. */
  creatable: (parent: string) => string;
}

export function dataDirCheck(dataDir: string): DirCheck {
  const dir = resolve(dataDir);
  return {
    label: 'data dir',
    dir,
    setting: 'dataDir',
    writable: `${dir} is writable`,
    creatable: (parent) => `${dir} does not exist yet; ${parent} is writable, so a run creates it`,
  };
}

export function markdownDirCheck(markdownDir: string): DirCheck {
  const dir = resolve(markdownDir);
  return {
    label: 'markdown',
    dir,
    setting: 'delivery.markdown.dir',
    writable: `digests are written to ${dir}`,
    creatable: (parent) =>
      `digests are written to ${dir}, which does not exist yet; ${parent} is writable, so a run creates it`,
  };
}

/** ok when the folder is writable or a run can create it; an error with a fix otherwise. */
export async function checkWritableDir(spec: DirCheck, io: DirIo): Promise<CheckResult> {
  const status = await inspectDir(spec.dir, spec.setting, io);
  switch (status.kind) {
    case 'writable':
      return ok(spec.label, spec.writable);
    case 'creatable':
      return ok(spec.label, spec.creatable(status.parent));
    case 'blocked':
      return fail(spec.label, status.problem, status.fix);
  }
}
