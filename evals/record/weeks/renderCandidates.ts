import type { Item } from '../../../src/domain/schemas';
import { truncate } from '../../../src/shared/text';
import { oneLine, pluralizeItems } from '../display';

const SUMMARY_MAX_CHARS = 200;

/** The labeling aid: one numbered entry per item, with everything needed to pick by id. */
export function renderCandidates(weekId: string, items: readonly Item[]): string {
  const intro =
    items.length === 0
      ? 'No items were recorded for this week.'
      : `${pluralizeItems(items.length)}. Pick the 5 must-include and any must-exclude items, ` +
        'then copy their ids into labels.json.';
  const entries = items.map((item, index) => renderCandidate(index + 1, item));
  return [`# Candidates: ${weekId}`, intro, ...entries].join('\n\n') + '\n';
}

function renderCandidate(position: number, item: Item): string {
  const published = new Date(item.publishedAt).toISOString().slice(0, 10);
  return [
    `${position}. **${oneLine(item.title) || '(untitled)'}**`,
    `   - id: \`${item.id}\``,
    `   - source: ${item.sourceId}, published ${published}`,
    `   - url: ${item.url}`,
    `   - summary: ${truncate(oneLine(item.summary), SUMMARY_MAX_CHARS) || '(none)'}`,
  ].join('\n');
}
