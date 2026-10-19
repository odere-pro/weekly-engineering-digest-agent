import type { SourceAnswer, SourceEntries, SourceTap } from '../../../sources/adapters/pipeline';

/** Collects what the debug tap sees, by source id. Nothing here touches the disk. */
export interface Recorder {
  /** Both listeners are set: the recorder wants every event. */
  tap: Required<SourceTap>;
  /** The source's own answers, in order. */
  answers: (sourceId: string) => readonly SourceAnswer[];
  /** The entry count of the source's last response; undefined if it was never read. */
  entries: (sourceId: string) => SourceEntries | undefined;
}

export function createRecorder(): Recorder {
  const answers = new Map<string, SourceAnswer[]>();
  const entries = new Map<string, SourceEntries>();
  return {
    tap: {
      answer: (event) => {
        answers.set(event.sourceId, [...(answers.get(event.sourceId) ?? []), event]);
      },
      entries: (event) => {
        entries.set(event.sourceId, event);
      },
    },
    answers: (sourceId) => answers.get(sourceId) ?? [],
    entries: (sourceId) => entries.get(sourceId),
  };
}
