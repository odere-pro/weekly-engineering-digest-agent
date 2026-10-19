import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../plan/types';

type FolderPlan = Pick<Plan, 'root' | 'day'>;

/** The folder of the fetch's day below the data folder: `<root>/<day>` (`store/layout.ts`). */
export function runFolderOf({ root, day }: FolderPlan): string {
  return join(root, day);
}

/**
 * Makes the day folder (and the data folder above it) and returns its path. Done before the first
 * request, so an output location that cannot be written shows at once.
 */
export async function createRunFolder(plan: FolderPlan): Promise<string> {
  const folder = runFolderOf(plan);
  await mkdir(folder, { recursive: true });
  return folder;
}
