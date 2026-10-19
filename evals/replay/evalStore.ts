import type { RunStore } from '../../src/store/RunStore';
import type { RunRecord } from '../../src/store/runRecord';
import { compareWeekIds } from '../../src/shared/isoWeek';

/** Run store that keeps everything in memory: replays must not touch data/. */
export function createEvalStore(): RunStore {
  const artifacts = new Map<string, string>();
  const records = new Map<string, RunRecord>();
  return {
    acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
    hasSentDigest: (runId) => Promise.resolve(records.get(runId)?.status === 'sent'),
    saveArtifact: (runId, name, content) => {
      artifacts.set(`${runId}/${name}`, content);
      return Promise.resolve();
    },
    readArtifact: (runId, name) => Promise.resolve(artifacts.get(`${runId}/${name}`)),
    saveRunRecord: (record) => {
      records.set(record.runId, record);
      return Promise.resolve();
    },
    getRunRecord: (runId) => Promise.resolve(records.get(runId)),
    // Replays are independent weeks: nothing counts as already sent.
    sentUrls: () => Promise.resolve(new Set<string>()),
    listRuns: (limit = Number.POSITIVE_INFINITY) =>
      Promise.resolve(
        [...records.values()].sort((a, b) => compareWeekIds(b.runId, a.runId)).slice(0, limit),
      ),
    prune: () => Promise.resolve([]),
  };
}
