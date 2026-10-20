import type { VariantKind } from '../../../store/runRecord';
import type { InitPrompts } from '../../init/types';

/** The questions a second run asks: the same prompts `digest init` uses. */
export type RunPrompts = Pick<InitPrompts, 'select' | 'input' | 'confirm'>;

/** What the user picked from the menu: a variant, or `skip` for today's behaviour. */
export type AgainChoice = VariantKind | 'skip';

/** The flags that pick a variant without the menu. */
export interface AgainFlags {
  enrich?: boolean;
  complete?: boolean;
  perspective?: string;
  addSource?: readonly string[];
}

/** What `digest run` was asked, as far as a second run cares. */
export interface AgainOptions extends AgainFlags {
  force?: boolean;
}

/** A variant, `ask` for the menu, or `undefined` for a plain run. */
export type AgainDecision = VariantKind | 'ask' | undefined;

/** The files a second run reads and writes (the config file); tests replace them. */
export interface FileIo {
  /** The text of a file, `undefined` when it does not exist. */
  readFile: (path: string) => Promise<string | undefined>;
  /** Writes a file whole or not at all. */
  writeFile: (path: string, content: string) => Promise<void>;
}
