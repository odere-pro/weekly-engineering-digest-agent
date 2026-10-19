import type { DigestView, DigestViewGroup, DigestViewItem } from '../../Delivery';
import { groupsWithItems, LAYOUT, type Urgency } from './emailLayout';
import { httpUrl, oneLine, titleOf } from './safeText';

function textItem(item: DigestViewItem, urgency: Urgency): string {
  const header = LAYOUT[urgency].action?.header;
  const action = header && item.action ? oneLine(item.action) : '';
  const url = httpUrl(item.url);
  const lines = [
    `- ${titleOf(item)}`,
    `  What changed: ${oneLine(item.whatChanged)}`,
    ...(action ? [`  ${header}: ${action}`] : []),
    ...(url ? [`  ${url}`] : []),
  ];
  return lines.join('\n');
}

function textGroup(group: DigestViewGroup): string {
  const heading = `${LAYOUT[group.urgency].emoji} ${oneLine(group.label)}`;
  return [heading, ...group.items.map((item) => textItem(item, group.urgency))].join('\n\n');
}

/**
 * The digest as a plain-text email body: title, headline, then per urgency a heading and one
 * bullet per item (title, what changed, the action line, the URL). Model strings are put on one
 * line each and only http(s) URLs are printed, so collected text cannot fake a bullet or a link.
 */
export function renderEmailText(view: DigestView): string {
  const footer = oneLine(view.footer ?? '');
  const blocks = [
    oneLine(view.title),
    oneLine(view.headline),
    ...groupsWithItems(view).map(textGroup),
    ...(footer ? [footer] : []),
  ];
  return `${blocks.join('\n\n')}\n`;
}
