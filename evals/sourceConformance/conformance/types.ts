/** What running one source's fetcher over its recording produced. */
export interface SourceResult {
  sourceId: string;
  /** Items the fetcher returned. */
  parsed: number;
  /** Items the recording must yield. */
  expected: number;
  schemaInvalid: number;
  emptyTitle: number;
  /** Fewer than `MIN_SUMMARY_CHARS` characters (`tally.ts`). */
  emptySummary: number;
  badDate: number;
  /** The id is not the hash of the item's URL. */
  idMismatch: number;
  hostOutsideAllowlist: number;
  /** Set when the fetcher threw; `parsed` is then 0. */
  error?: string;
}
