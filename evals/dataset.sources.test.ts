// The contract of every default source: the real response it served, and the items it must
// yield. Every adapter keeps this test green; W6-02 removes `knownGaps` as it fixes parsing.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conformanceProblems } from './sourceConformance/conformance/conformanceProblems';
import { defaultFetcherFactories } from './sourceConformance/replayFetch/fetcherFactories';
import { fetchFromRecording } from './sourceConformance/replayFetch/fetchFromRecording';
import { loadSourceRecordings } from './sourceConformance/recordings/loadSourceRecordings';
import { DEFAULT_SOURCES } from '../src/sources/defaultSources';

const recordings = await loadSourceRecordings(join(import.meta.dirname, 'sources'));

describe('recorded sources', () => {
  it('cover every default source', () => {
    const recorded = new Set(recordings.map((r) => r.source.id));
    expect(DEFAULT_SOURCES.filter((s) => !recorded.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  it.each(recordings.map((r) => [r.source.id, r] as const))(
    '%s yields the expected items',
    async (_id, recording) => {
      expect(recording.expected.reviewed, 'expected.json is checked by hand').toBe(true);
      const items = await fetchFromRecording(recording, defaultFetcherFactories);

      expect(items.length).toBe(recording.expected.items.length);
      expect(
        conformanceProblems(items, recording.expected.items, recording.expected.knownGaps),
      ).toEqual([]);
    },
  );
});
