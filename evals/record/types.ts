import type { Item, Source } from '../../src/domain/schemas';

/** The sources a recording run uses, and where the list came from. */
export interface ResolvedSources {
  sources: readonly Source[];
  origin: 'config' | 'default';
  githubToken?: string;
}

/** What a recording run did for one week: the items now in its `items.json`. */
export interface WeekRecord {
  weekId: string;
  items: readonly Item[];
  /** Items an earlier run had already recorded; undefined when this run created items.json. */
  alreadyRecorded?: number;
}
