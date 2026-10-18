import type { DigestView, DigestViewGroup, DigestViewItem } from '../delivery/Delivery';
import { buildDigestView, type LayoutOptions } from './layout';
import { UrgencySchema, type Digest, type Urgency } from '../domain/schemas';

export type RenderOptions = LayoutOptions;

const URGENCY_EMOJI: Readonly<Record<Urgency, string>> = {
  'act-now': '🔴',
  'worth-a-look': '🟡',
  'good-to-know': '⚪',
};

/** The heading of the third column; a good-to-know item has no such column. */
const ACTION_HEADING: Readonly<Record<Urgency, string | undefined>> = {
  'act-now': 'What to do',
  'worth-a-look': 'Relevant if you',
  'good-to-know': undefined,
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Plain text in a table cell: one line, and a pipe that cannot end the cell. A table reads `\\` as
 * one escaped backslash, so a backslash run right before a pipe is doubled to keep the pipe's own
 * escape. Other backslashes stay as the writer wrote them.
 */
function cell(text: string): string {
  // The lookbehind starts a match at the beginning of a backslash run, so a long run is scanned once.
  return oneLine(text).replace(/(?<!\\)(\\*)\|/g, '$1$1\\|');
}

/** Text in `[...]` of a link: backslashes, brackets and pipes are escaped, as linkCheck decodes them. */
const escapeLinkText = (text: string): string => text.replace(/[\\[\]|]/g, '\\$&');

/** The destination in `(...)` of a link: backslashes and pipes are escaped the same way. */
const escapeDestination = (url: string): string => url.replace(/[\\|]/g, '\\$&');

/** The release cell: the title, linked to the item's page. A blank title shows the url. */
function releaseCell({ title, url }: DigestViewItem): string {
  const target = oneLine(url);
  const label = oneLine(title) || target;
  return `[${escapeLinkText(label)}](${escapeDestination(target)})`;
}

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

/** A word character, or an apostrophe inside a word: the heading is not a whole word before it. */
const WORD_CHARACTER = /^[\p{L}\p{N}'’]/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * The column heading already says "Relevant if you", and a writer is asked to start that action
 * with the same words. Drop the repeat so the cell completes the sentence instead of echoing it.
 * Text that is not such a repeat, or would be left without a word, stays as it is.
 */
function withoutHeading(action: string, heading: string): string {
  const text = action.trim();
  const rest = text.slice(heading.length);
  if (!text.toLowerCase().startsWith(heading.toLowerCase()) || WORD_CHARACTER.test(rest)) {
    return text;
  }
  const completed = rest.replace(/^[\s,:-]+/, '');
  return HAS_WORD.test(completed) ? completed : text;
}

function renderGroup(group: DigestViewGroup): string {
  const actionHeading = ACTION_HEADING[group.urgency];
  const header = [
    'Release',
    'What changed',
    ...(actionHeading === undefined ? [] : [actionHeading]),
  ];
  const body = group.items.map((item) =>
    row([
      releaseCell(item),
      cell(item.whatChanged),
      ...(actionHeading === undefined
        ? []
        : [cell(withoutHeading(item.action ?? '', actionHeading))]),
    ]),
  );
  return [
    `## ${URGENCY_EMOJI[group.urgency]} ${group.label}`,
    [row(header), `|${'---|'.repeat(header.length)}`, ...body].join('\n'),
  ].join('\n\n');
}

/** A laid-out digest -> Markdown: a title, the headline, then one table per urgency. */
export function renderView(view: DigestView): string {
  const headline = oneLine(view.headline);
  const blocks = [
    `# ${view.title}`,
    ...(headline === '' ? [] : [`_${headline}_`]),
    ...view.groups.map(renderGroup),
  ];
  if (view.footer !== undefined) blocks.push('---', view.footer);
  return `${blocks.join('\n\n')}\n`;
}

/** Digest -> Markdown, laid out by `buildDigestView`. The intro is not shown. */
export function renderDigest(digest: Digest, options: RenderOptions): string {
  return renderView(buildDigestView(digest, options));
}

// --- Reading a digest.md back ---------------------------------------------------------------

/**
 * The first line of a digest.md in the layout above: the title `titleOf` in layout.ts computes,
 * "Week <id>: <n> releases, <k> need action". A headline that starts with "Week 2026-W42: " is not
 * one, which tells a file saved before W8-02 apart.
 */
const TITLE_LINE = /^# (Week (\d{4}-W\d{2}): \d+ releases?, .*)$/;
const HEADLINE_LINE = /^_(.+)_$/;
const GROUP_HEADING = /^## (\S+) (.+)$/;
/** One cell of a table row: between two unescaped pipes, with a backslash taking the next char. */
const TABLE_CELL = /\|((?:\\.|[^\\|])*)(?=\|)/g;
const FIRST_CELL = /^\|((?:\\.|[^\\|])*)(?=\|)/;
/** The release cell: `[title](url)`. */
const RELEASE_CELL = /^\[((?:\\.|[^\\\]])*)\]\(((?:[^\s()]|\([^\s()]*\))*)\)$/;
/** Before W8-02 the first `# ` line was the headline, and each item ended in a `[Source](url)` line. */
const LEGACY_HEADLINE_LINE = /^# (.+)$/m;
const LEGACY_SOURCE_LINE = /^\[Source\]\((.+)\)$/gm;

const URGENCY_OF_EMOJI: ReadonlyMap<string, Urgency> = new Map(
  UrgencySchema.options.map((urgency): [string, Urgency] => [URGENCY_EMOJI[urgency], urgency]),
);

/**
 * Undoes `cell`: an odd run of backslashes before a pipe held half as many, plus the pipe's own.
 * The lookbehind starts a match at the beginning of a run, so a long run is scanned once.
 */
const unescapeCell = (text: string): string =>
  text.replace(
    /(?<!\\)(\\+)\|/g,
    (_run, slashes: string) => `${'\\'.repeat((slashes.length - 1) / 2)}|`,
  );

/** Undoes `escapeLinkText` and `escapeDestination`. */
const unescapeLink = (text: string): string => text.replace(/\\([\\[\]|])/g, '$1');

function readRow(row: string, urgency: Urgency): DigestViewItem {
  const [release = '', changed = '', action = ''] = Array.from(row.matchAll(TABLE_CELL), (match) =>
    (match[1] ?? '').trim(),
  );
  const link = RELEASE_CELL.exec(release);
  const item: DigestViewItem = {
    title: link ? unescapeLink(link[1] ?? '') : unescapeCell(release),
    url: link ? unescapeLink(link[2] ?? '') : '',
    whatChanged: unescapeCell(changed),
  };
  return ACTION_HEADING[urgency] === undefined ? item : { ...item, action: unescapeCell(action) };
}

/** The tables of the groups, in order. A group with a heading this layout does not write is skipped. */
function readGroups(lines: readonly string[]): DigestViewGroup[] {
  const headings = lines.flatMap((line, at) => {
    const match = GROUP_HEADING.exec(line);
    return match === null ? [] : [{ at, emoji: match[1] ?? '', label: match[2] ?? '' }];
  });
  return headings.flatMap(({ at, emoji, label }, n) => {
    const urgency = URGENCY_OF_EMOJI.get(emoji);
    if (urgency === undefined) return [];
    const section = lines.slice(at + 1, headings[n + 1]?.at ?? lines.length);
    // The first two lines of a table are its header and its separator.
    const rows = section.filter((line) => line.startsWith('|')).slice(2);
    return [{ urgency, label, items: rows.map((row) => readRow(row, urgency)) }];
  });
}

/** The line after the `---` rule that `renderView` writes before the footer. */
function readFooter(lines: readonly string[]): string | undefined {
  const rule = lines.lastIndexOf('---');
  return rule < 0 ? undefined : lines.slice(rule + 1).find((line) => line.trim() !== '');
}

/**
 * Reads a digest.md of the layout `renderView` writes back into a view; undefined for any other
 * text. Text a cell could not hold on one line comes back on one line, and a "Relevant if you"
 * that the layout dropped from an action is not restored. Never throws.
 */
export function readSavedView(markdown: string): DigestView | undefined {
  const lines = markdown.split('\n');
  const title = TITLE_LINE.exec(lines[0] ?? '');
  if (title === null) return undefined;
  // The title is one line, then a blank line, then the headline in italics when there is one.
  const footer = readFooter(lines);
  return {
    weekId: title[2] ?? '',
    title: title[1] ?? '',
    headline: HEADLINE_LINE.exec(lines[2] ?? '')?.[1] ?? '',
    groups: readGroups(lines),
    ...(footer === undefined ? {} : { footer }),
  };
}

/** What a resume reads back from a digest.md. */
export interface SavedDigest {
  /** Empty when the file shows none. */
  readonly headline: string;
  /** The page of each item, in the file's order. */
  readonly urls: readonly string[];
}

/**
 * The url of every release row, wherever it sits: a row opens with a linked title. A resume sends
 * only a digest whose urls are the ones that went out, so this reads rows under any heading.
 */
function releaseUrls(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    if (!line.startsWith('| [')) return [];
    const link = RELEASE_CELL.exec((FIRST_CELL.exec(line)?.[1] ?? '').trim());
    return link === null ? [] : [unescapeLink(link[2] ?? '')];
  });
}

/**
 * Reads a digest.md back: the headline and the item urls. Understands the layout of `renderView`
 * and the one a run saved before it, so a week that was part delivered across an upgrade resumes.
 */
export function readSavedDigest(markdown: string): SavedDigest {
  const view = readSavedView(markdown);
  if (view === undefined) {
    return {
      headline: LEGACY_HEADLINE_LINE.exec(markdown)?.[1] ?? '',
      urls: Array.from(markdown.matchAll(LEGACY_SOURCE_LINE), (match) => match[1] ?? ''),
    };
  }
  return { headline: view.headline, urls: releaseUrls(markdown.split('\n')) };
}
