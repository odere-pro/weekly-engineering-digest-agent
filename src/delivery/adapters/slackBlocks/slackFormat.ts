import { visibleText } from '../../visibleText';

const HEADING_LINE = /^#{1,6}[ \t]+(\S.*)$/;
// Only absolute http(s) destinations, one level of balanced parentheses, no `|` (Slack's separator).
const MARKDOWN_LINK = /!?\[([^\]\n]{1,200})\]\((https?:\/\/(?:[^()\s|]|\([^()\s|]*\)){1,2048})\)/g;
const BOLD = /\*\*(.+?)\*\*/g;

/** Slack reads these three characters as markup, so collected text must not carry them raw. */
export function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function headingToBold(line: string): string {
  const match = HEADING_LINE.exec(line);
  return match?.[1] ? `*${match[1].replaceAll('**', '').trim()}*` : line;
}

/**
 * Digest Markdown to Slack mrkdwn: [t](u) to <u|t>, **b** to *b*, headings to bold lines.
 * Invisible characters go first (`visibleText`: line breaks stay), so a bidi override or a
 * zero-width character cannot reorder or hide what Slack shows. Then everything is escaped, and
 * only http(s) links become Slack links, so collected text cannot produce `<!channel>`,
 * `<@U123>` or similar control tokens.
 */
export function toSlackMrkdwn(markdown: string): string {
  const escaped = escapeSlack(visibleText(markdown));
  return escaped
    .split('\n')
    .map(headingToBold)
    .join('\n')
    .replace(MARKDOWN_LINK, '<$2|$1>')
    .replace(BOLD, '*$1*');
}
