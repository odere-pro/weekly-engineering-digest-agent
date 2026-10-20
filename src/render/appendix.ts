import type { ScoredItem } from '../classify/classification';
import type { DigestAppendix, DigestAppendixGroup } from './digestView';
import { escapeDestination, escapeLine, escapeLinkText } from './markdown';
import { cutSummary, plain, titleOf } from './sourceLine';
import { visibleLine } from './visibleLine';

const APPENDIX_TITLE = 'Everything this week';
const LINE_WORDS = 25;
const NO_AREA = 'Releases';

/**
 * Every given release grouped by area, areas in first-seen order of the rank-ordered list. Title
 * and line come from the item's own text (`sourceLine`), never from a model. No items, no
 * appendix. Pure.
 */
export function buildAppendix(items: readonly ScoredItem[]): DigestAppendix | undefined {
  if (items.length === 0) return undefined;
  const byArea = new Map<string, DigestAppendixGroup['items'][number][]>();
  for (const item of items) {
    const area = plain(item.classification.area) || NO_AREA;
    const entry = {
      title: titleOf(item),
      url: item.url,
      line: cutSummary(item.summary, LINE_WORDS),
    };
    byArea.set(area, [...(byArea.get(area) ?? []), entry]);
  }
  return {
    title: APPENDIX_TITLE,
    groups: [...byArea].map(([area, areaItems]) => ({ area, items: areaItems })),
  };
}

/** The appendix as Markdown: a `##` heading, a `###` per area and a linked bullet per release. */
export function renderAppendix(appendix: DigestAppendix): string {
  const groups = appendix.groups.map((group) => {
    const bullets = group.items.map((item) => {
      const target = visibleLine(item.url);
      const label = visibleLine(item.title) || target;
      return `- [${escapeLinkText(label)}](${escapeDestination(target)}): ${escapeLine(item.line)}`;
    });
    return `### ${escapeLine(group.area)}\n\n${bullets.join('\n')}`;
  });
  return `\n## ${escapeLine(appendix.title)}\n\n${groups.join('\n\n')}\n`;
}
