import type { Item } from '../../../domain/schemas';

/** What an adapter found in one entry of its vendor's response; nothing is normalized yet. */
export interface RawEntry {
  url: string;
  title: string;
  /** The richest body the response carries, HTML or Markdown allowed, not truncated; empty if none. */
  text: string;
  /** A date text is read like a feed date: a time without a zone is UTC. */
  publishedAt: string | Date;
  /** The feed's own id for the entry; tells apart entries that share a link. */
  entryId?: string;
}

/** A raw entry with the item it became. */
export interface Pair {
  entry: RawEntry;
  item: Item;
}
