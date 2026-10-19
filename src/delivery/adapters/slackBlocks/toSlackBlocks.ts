import type { DigestView, DigestViewGroup, DigestViewItem } from '../../Delivery';
import { truncate } from '../../../shared/text';
import { escapeSlack } from './slackFormat';

/** One Block Kit block, limited to the four kinds the digest uses. */
export type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string } }
  | { type: 'context'; elements: readonly { type: 'mrkdwn'; text: string }[] }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'divider' };

/** The body of a Slack webhook post: blocks for the reader, `text` for notifications. */
export interface SlackMessage {
  text: string;
  blocks: readonly SlackBlock[];
}

// Slack's limits for one message.
const MAX_BLOCKS = 50;
const MAX_SECTION_CHARS = 3000;
const MAX_HEADER_CHARS = 150;

// Budgets for model and collected text, counted after escaping. The item budgets sum to well
// under MAX_SECTION_CHARS together with the link markup, so one bullet always fits a section
// next to its group label.
const MAX_TITLE_CHARS = 200;
const MAX_WHAT_CHANGED_CHARS = 1000;
const MAX_ACTION_CHARS = 400;
const MAX_URL_CHARS = 1200;
const MAX_LABEL_CHARS = 100;
const MAX_HEADLINE_CHARS = 600;
const MAX_FOOTER_CHARS = 1000;

const BULLET = '•';
const ARROW = '→';
const OMISSION_NOTE = `Some items are not shown: Slack allows ${String(MAX_BLOCKS)} blocks per message.`;

const URGENCY_EMOJI: Readonly<Record<DigestViewGroup['urgency'], string>> = {
  'act-now': '\u{1F534}',
  'worth-a-look': '\u{1F7E1}',
  'good-to-know': '⚪',
};

/** A new object each time, so a caller that edits one message cannot change another. */
function divider(): SlackBlock {
  return { type: 'divider' };
}

/**
 * One line of text: line breaks and control characters become spaces, so collected or model
 * text cannot forge bullets or headings. A backtick becomes an apostrophe, so no code fence
 * can open and swallow the bullets that follow.
 */
function oneLine(text: string): string {
  return text
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replaceAll('`', "'")
    .trim();
}

/**
 * `raw` escaped for Slack and at most `maxChars` long after escaping. The cut is made on the raw
 * text and the result re-measured, so an entity such as `&amp;` is never cut in half.
 */
function fitEscaped(raw: string, maxChars: number): string {
  let limit = maxChars;
  for (;;) {
    const escaped = escapeSlack(truncate(raw, limit));
    // Every caller passes a budget of at least 3, which "..." fits, so the loop ends: the limit
    // falls by at least one each round and shrinks in proportion to how far the text overshoots.
    if (escaped.length <= maxChars) return escaped;
    limit = Math.min(limit - 1, Math.floor((limit * maxChars) / escaped.length));
  }
}

/**
 * The escaped destination of a Slack link, or undefined when the text is not a plain http(s)
 * URL that fits. A URL with a user name or password is refused: `https://github.com@evil.example`
 * reads as one host and goes to another. `new URL` percent-encodes spaces, `<` and `>`; `|`
 * would end the link target early, so it is encoded here.
 */
function linkTarget(raw: string): string | undefined {
  if (!URL.canParse(raw)) return undefined;
  const { protocol, href, username, password } = new URL(raw);
  if (protocol !== 'http:' && protocol !== 'https:') return undefined;
  if (username !== '' || password !== '') return undefined;
  const target = escapeSlack(href.replaceAll('|', '%7C'));
  return target.length <= MAX_URL_CHARS ? target : undefined;
}

/** `• *<url|title>*: what changed`, then `→ action` on the next line when there is one. */
function bulletOf(item: DigestViewItem): string {
  const title = fitEscaped(oneLine(item.title), MAX_TITLE_CHARS);
  const target = linkTarget(item.url);
  const shownTitle = target === undefined ? title : `<${target}|${title}>`;
  const whatChanged = fitEscaped(oneLine(item.whatChanged), MAX_WHAT_CHANGED_CHARS);
  const action = fitEscaped(oneLine(item.action ?? ''), MAX_ACTION_CHARS);
  const first = `${BULLET} *${shownTitle}*: ${whatChanged}`;
  return action === '' ? first : `${first}\n${ARROW} ${action}`;
}

/** Fills sections in order: the label opens the first, and a bullet starts a new one when full. */
function packSections(label: string, bullets: readonly string[]): string[] {
  const full: string[] = [];
  let current = label;
  for (const bullet of bullets) {
    if (current.length + 1 + bullet.length <= MAX_SECTION_CHARS) {
      current = `${current}\n${bullet}`;
    } else {
      full.push(current);
      current = bullet;
    }
  }
  return [...full, current];
}

function sectionBlock(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function contextBlock(text: string): SlackBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function groupBlocks(group: DigestViewGroup): SlackBlock[] {
  const emoji = URGENCY_EMOJI[group.urgency];
  const label = `*${emoji} ${fitEscaped(oneLine(group.label), MAX_LABEL_CHARS)}*`;
  return packSections(label, group.items.map(bulletOf)).map(sectionBlock);
}

/** The group sections with a divider between groups. Groups without items are skipped. */
function bodyBlocks(groups: readonly DigestViewGroup[]): SlackBlock[] {
  return groups
    .filter((group) => group.items.length > 0)
    .flatMap((group, index) => [...(index === 0 ? [] : [divider()]), ...groupBlocks(group)]);
}

/** Keeps `body` within `room` blocks; when it is cut, the last slot says so. */
function fitBlocks(body: readonly SlackBlock[], room: number): readonly SlackBlock[] {
  return body.length <= room ? body : [...body.slice(0, room - 1), contextBlock(OMISSION_NOTE)];
}

/**
 * The digest view as a Slack Block Kit message: a header, the headline, then one section per
 * urgency group with a bullet per item (Slack has no tables), and the footer if there is one.
 * Text from the model or from collected items is escaped, so it cannot ping a channel or form
 * a link; sizes follow Slack's limits. Pure: the same view gives the same message.
 */
export function toSlackBlocks(view: DigestView): SlackMessage {
  // Slack rejects a header or context block with empty text, and with it the whole message.
  const title = truncate(oneLine(view.title) || `Weekly digest ${view.weekId}`, MAX_HEADER_CHARS);
  const headline = fitEscaped(oneLine(view.headline), MAX_HEADLINE_CHARS);
  const footer = fitEscaped(oneLine(view.footer ?? ''), MAX_FOOTER_CHARS);
  const head: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    ...(headline === '' ? [] : [contextBlock(headline)]),
  ];
  const tail = footer === '' ? [] : [contextBlock(footer)];
  const room = MAX_BLOCKS - head.length - tail.length;
  return {
    text: headline === '' ? escapeSlack(title) : `${escapeSlack(title)}\n${headline}`,
    blocks: [...head, ...fitBlocks(bodyBlocks(view.groups), room), ...tail],
  };
}
