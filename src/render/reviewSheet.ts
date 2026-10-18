import { DigestError } from '../shared/errors';
import { truncate } from '../shared/text';
import { WEEK_ID_PATTERN, type Item } from '../domain/schemas';
import { type Classification } from '../classify/classification';

/** Candidates the sheet lists after the picked items: the best the digest left out. */
export const MAX_CANDIDATES = 20;
const TITLE_MAX_CHARS = 120;
const SCORE_DECIMALS = 2;
const NONE = '-';

export interface ReviewSheetInput {
  readonly weekId: string;
  /** The week's collected items; they give each line its title and url. */
  readonly items: readonly Item[];
  /** The classifier's output in stored order (scores.json); the position is the rank. */
  readonly classifications: readonly Classification[];
  /** The ids of the items the digest includes, in digest order. */
  readonly pickedIds: readonly string[];
}

/** What the reader ticked: picks that should not have been there, candidates that should have. */
export interface ReviewFeedback {
  readonly weekId: string;
  readonly wrongPicks: readonly string[];
  readonly missed: readonly string[];
}

interface Entry {
  readonly id: string;
  readonly rank: string;
  readonly score: string;
  readonly title: string;
  readonly url: string;
}

const TITLE_HEADING = '# Review sheet: ';
const PICKED_HEADING = '## Picked';
const CANDIDATES_HEADING = '## Candidates';
const NO_ENTRIES = '_None._';
/** Characters that start Markdown structure; a backslash in front keeps them literal. */
const MARKDOWN_SPECIAL = /[\\`*_[\]<>#|~!&]/g;
const URL_UNSAFE = /[<>|\s`]/g;
const ITEM_LINE = /^- \[([ xX])\] `([^`\s]+)` \| rank (\d+|-) \| score (\d+\.\d{2}|-) \| .+$/;
/** Anything that looks like a checkbox line, so an edited one is reported rather than skipped. */
const CHECKBOX_LIKE = /^\s*[-*+]\s*\[/;

/** The review sheet of a run (W7-07): no model call, built from the run's own files. */
export function buildReviewSheet(input: ReviewSheetInput): string {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const ranked = input.classifications.map((classification, index) => ({
    classification,
    rank: index + 1,
  }));
  const rankOf = new Map(ranked.map((entry) => [entry.classification.itemId, entry]));
  const entryOf = (id: string): Entry | undefined => {
    const item = byId.get(id);
    if (!item) return undefined;
    const found = rankOf.get(id);
    return {
      id,
      rank: found ? String(found.rank) : NONE,
      score: found ? found.classification.relevance.toFixed(SCORE_DECIMALS) : NONE,
      title: item.title,
      url: item.url,
    };
  };
  const picked = new Set(input.pickedIds);
  const pickedEntries = input.pickedIds.flatMap((id) => entryOf(id) ?? []);
  const candidateEntries = ranked
    .filter(({ classification }) => !picked.has(classification.itemId))
    .flatMap(({ classification }) => entryOf(classification.itemId) ?? [])
    .slice(0, MAX_CANDIDATES);
  return [
    `${TITLE_HEADING}${input.weekId}`,
    '',
    'Tick `[x]` a picked item that should not have been in the digest, and tick a candidate ' +
      'that should have been. Leave everything else as it is. ' +
      `Then run \`digest feedback ${input.weekId}\`.`,
    '',
    PICKED_HEADING,
    '',
    ...section(pickedEntries),
    '',
    CANDIDATES_HEADING,
    '',
    ...section(candidateEntries),
    '',
  ].join('\n');
}

function section(entries: readonly Entry[]): string[] {
  return entries.length === 0 ? [NO_ENTRIES] : entries.map(renderEntry);
}

function renderEntry({ id, rank, score, title, url }: Entry): string {
  return `- [ ] \`${id}\` | rank ${rank} | score ${score} | ${escapeTitle(title)} | <${safeUrl(url)}>`;
}

/** One line of plain text: whitespace collapsed, shortened, every Markdown character escaped. */
function escapeTitle(title: string): string {
  const line = title.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return truncate(line, TITLE_MAX_CHARS).replace(MARKDOWN_SPECIAL, (char) => `\\${char}`);
}

function safeUrl(url: string): string {
  return url.replace(URL_UNSAFE, (char) => encodeURIComponent(char));
}

type Section = 'picked' | 'candidates';

/** Reads the ticks of a sheet `buildReviewSheet` wrote. Throws a DigestError naming the line. */
export function parseReviewSheet(text: string): ReviewFeedback {
  const lines = text.split(/\r?\n/);
  const weekId = weekOf(lines[0]);
  const wrongPicks: string[] = [];
  const missed: string[] = [];
  const seen = new Set<string>();
  const sectionsSeen = new Set<Section>();
  let current: Section | undefined;
  lines.forEach((line, index) => {
    const at = index + 1;
    if (line === PICKED_HEADING || line === CANDIDATES_HEADING) {
      current = line === PICKED_HEADING ? 'picked' : 'candidates';
      sectionsSeen.add(current);
      return;
    }
    if (!CHECKBOX_LIKE.test(line)) return;
    const match = ITEM_LINE.exec(line);
    if (!match) throw malformed(at, 'this item line was edited; keep it as written');
    if (!current)
      throw malformed(at, 'this item line is outside the Picked and Candidates sections');
    const id = match[2] ?? '';
    if (seen.has(id)) throw malformed(at, `${id} is listed twice`);
    seen.add(id);
    if (match[1] === ' ') return;
    (current === 'picked' ? wrongPicks : missed).push(id);
  });
  if (!sectionsSeen.has('picked'))
    throw new DigestError(`The sheet has no "${PICKED_HEADING}" section`);
  if (!sectionsSeen.has('candidates'))
    throw new DigestError(`The sheet has no "${CANDIDATES_HEADING}" section`);
  return { weekId, wrongPicks, missed };
}

function weekOf(first: string | undefined): string {
  const weekId = first?.startsWith(TITLE_HEADING) ? first.slice(TITLE_HEADING.length).trim() : '';
  if (!WEEK_ID_PATTERN.test(weekId)) {
    throw malformed(1, `expected "${TITLE_HEADING}<week>" with an ISO week id such as 2026-W43`);
  }
  return weekId;
}

function malformed(line: number, problem: string): DigestError {
  return new DigestError(`Malformed review sheet, line ${line}: ${problem}`);
}
