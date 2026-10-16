import type { Item, Source, SourceKind } from '../../src/core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../src/ports/SourceFetcher.js';

/** Returns canned items per source id; an Error value makes that source fail. */
export class FakeSourceFetcher implements SourceFetcher {
  readonly calls: { source: Source; window: FetchWindow }[] = [];
  constructor(
    readonly kind: SourceKind,
    private readonly bySource: Readonly<Record<string, Item[] | Error>>,
  ) {}

  fetch(source: Source, window: FetchWindow): Promise<Item[]> {
    this.calls.push({ source, window });
    const result = this.bySource[source.id] ?? [];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}
