import { resolve, sep } from 'node:path';
import { ConfigSchema } from '../../../config/schema';
import { isoWeekId } from '../../../shared/isoWeek';
import { weekDigestDir } from '../../../store/layout';
import type { InitIo, ValidateSelection } from '../types';
import { isTimeZone } from './timeZone';

/** The channels question's value for the Markdown and HTML files, which every run writes. */
export const SAVE_LOCALLY = 'markdown';

export const SAVE_LOCALLY_REQUIRED = 'Saving locally is always on: keep it ticked.';

/** The data folder of a config that does not set `dataDir`, which is what `digest init` writes. */
const DEFAULT_DATA_DIR = ConfigSchema.shape.dataDir.parse(undefined);

export interface LocalFolderWhere {
  /** The schedule's zone: it decides which week it is. */
  timeZone: string;
  inDocker: boolean;
  /** Default: the one a config without `dataDir` has. */
  dataDir?: string;
}

/**
 * Where this week's digest files go, as init shows it: the Monday folder of the clock's week
 * (`store/layout`), below the data folder, which a run resolves against the folder it starts in.
 * In Docker that folder is inside the container, so it names the `./dist` mount on the host.
 */
export function localFolder(io: Pick<InitIo, 'cwd' | 'clock'>, where: LocalFolderWhere): string {
  const dataDir = where.dataDir ?? DEFAULT_DATA_DIR;
  // A zone `Intl` does not know is refused by the config check after the questions; it must not
  // crash the folder line first, so the week is counted in UTC then.
  const timeZone = isTimeZone(where.timeZone) ? where.timeZone : 'UTC';
  const weekFolder = weekDigestDir(dataDir, isoWeekId(io.clock.now(), timeZone));
  if (where.inDocker) return `./${weekFolder}/ on the host`;
  return `${resolve(io.cwd, weekFolder)}${sep}`;
}

/** The first choice of the channels question: ticked, with the folder in its label. */
export function saveLocallyChoice(folder: string): {
  name: string;
  value: string;
  checked: true;
} {
  return {
    name: `Save locally (Markdown and HTML): ${folder}`,
    value: SAVE_LOCALLY,
    checked: true,
  };
}

/** The Markdown files are written whatever the config says, so the question cannot untick them. */
export const requireSaveLocally: ValidateSelection = (selected) =>
  selected.some((choice) => choice.value === SAVE_LOCALLY) ? true : SAVE_LOCALLY_REQUIRED;
