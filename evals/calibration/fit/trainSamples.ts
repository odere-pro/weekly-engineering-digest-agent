import { isFailed, type RawCapture } from '../../thresholds/capture/schemas';
import { splitCapture, type Split } from '../../thresholds/split';
import type { Sample } from './types';

/** Target relevance of a must-include and of a must-exclude week item. */
const MUST_INCLUDE_TARGET = 3;
const MUST_EXCLUDE_TARGET = 0;

/** Train samples: the classifier cases (their label) and the labeled week items (3 or 0). */
export function trainSamples(capture: RawCapture, split: Split): Sample[] {
  const { train } = splitCapture(capture, split);
  const cases = train.classifier.flatMap((record) =>
    isFailed(record.result)
      ? []
      : [
          {
            raw: record.result.relevance,
            area: record.result.area,
            target: record.expected.relevance,
          },
        ],
  );
  const weekItems = train.weekItems.flatMap((record) => {
    if (record.label === null || isFailed(record.result)) return [];
    const target = record.label === 'mustInclude' ? MUST_INCLUDE_TARGET : MUST_EXCLUDE_TARGET;
    return [{ raw: record.result.relevance, area: record.result.area, target }];
  });
  return [...cases, ...weekItems];
}
