import type { Source } from '../../../src/domain/schemas';
import type { SourceExpected, SourceResponse } from '../../schema';

/** One recorded source: what it served and the items that must come out of it. */
export interface SourceRecording {
  source: Source;
  response: SourceResponse;
  body: string;
  /** Recorded article pages by URL (`pages/<item id>.html.txt`), served to the enrichment step. */
  pages: Readonly<Record<string, string>>;
  expected: SourceExpected;
}
