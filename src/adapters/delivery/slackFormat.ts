const HEADING_LINE = /^#{1,6}[ \t]+(\S.*)$/;
// Only absolute http(s) destinations, one level of balanced parentheses, no `|` (Slack's separator).
const MARKDOWN_LINK = /!?\[([^\]\n]{1,200})\]\((https?:\/\/(?:[^()\s|]|\([^()\s|]*\)){1,2048})\)/g;
const BOLD = /\*\*(.+?)\*\*/g;

/** Slack reads these three characters as markup, so collected text must not carry them raw. */
function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function headingToBold(line: string): string {
  const match = HEADING_LINE.exec(line);
  return match?.[1] ? `*${match[1].replaceAll('**', '').trim()}*` : line;
}

/**
 * Digest Markdown to Slack mrkdwn: [t](u) to <u|t>, **b** to *b*, headings to bold lines.
 * Everything is escaped first, and only http(s) links become Slack links, so collected text
 * cannot produce `<!channel>`, `<@U123>` or similar control tokens.
 */
export function toSlackMrkdwn(markdown: string): string {
  const escaped = escapeSlack(markdown.replaceAll('\r\n', '\n'));
  return escaped
    .split('\n')
    .map(headingToBold)
    .join('\n')
    .replace(MARKDOWN_LINK, '<$2|$1>')
    .replace(BOLD, '*$1*');
}
