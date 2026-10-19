import { normalizeText } from '../normalizeText';

/**
 * A dotted version in a title: `1.34`, `v5.20.0`, `2.1.5-rc1`. It must start and end at a word
 * edge, so `build1.2.3`, `1.2.3abc` and a bare `3` or `2026` never count.
 */
const VERSION_TOKEN = /(?<![\w.])v?(\d+(?:\.\d+)+(?:-[a-z0-9.]*[a-z0-9])?)(?!\w|\.\d)/;
const EVERY_VERSION_TOKEN = new RegExp(VERSION_TOKEN.source, 'g');
/** A subtitle after the version: "v1.34: Of Wind & Will", "2.0 - Fast Lane". */
const SUBTITLE = /^\s*(?::|[-\u2013\u2014]\s)/;
/** Words around a product name that are not part of it: "Announcing X", "X release 1.2". */
const LEADING_FILLER: ReadonlySet<string> = new Set(['announcing', 'introducing', 'new', 'the']);
const TRAILING_FILLER: ReadonlySet<string> = new Set([
  'release',
  'released',
  'version',
  'tag',
  'v',
]);
/**
 * First word after the version of a title that reports the release itself ("X 1.2 is out",
 * "X 1.2 on Platform"). A noun there ("X 1.2 Sonnet", "X 1.2 support in Y") names another product.
 */
const ANNOUNCEMENT_WORDS: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'has',
  'have',
  'now',
  'just',
  'finally',
  'out',
  'live',
  'ga',
  'generally',
  'available',
  'released',
  'ships',
  'shipped',
  'arrives',
  'arrived',
  'lands',
  'landed',
  'launches',
  'launched',
  'announced',
  'adds',
  'brings',
  'introduces',
  'on',
  'in',
]);

/**
 * "product@version" for a title that only reports one release, else ''. The product is the words
 * before the first version token, minus filler. Two sources share a release only if both parts
 * are equal and the rest of each title is an announcement (see `announcesRelease`).
 * Deliberately narrow: a missed merge is left to the writer, a wrong merge drops real news.
 */
export function releaseKeyOf(title: string): string {
  const folded = title.normalize('NFKC').toLowerCase();
  const match = VERSION_TOKEN.exec(folded);
  const rawVersion = match?.[1];
  if (match === null || rawVersion === undefined) return '';
  const version = canonicalVersion(rawVersion);
  const tail = folded.slice(match.index + match[0].length);
  if (!announcesRelease(tail, version, folded)) return '';
  const product = productName(folded.slice(0, match.index));
  return product === '' ? '' : `${product}@${version}`;
}

/**
 * True when what follows the version is nothing, a subtitle or an announcement phrase, and the
 * title names no other version. Anything else ("3.5 Haiku", "3.13 support in numpy", "1.2 vs 1.1")
 * is a different story that merely shares a prefix and a version.
 */
function announcesRelease(tail: string, version: string, title: string): boolean {
  const namesOtherVersion = [...title.matchAll(EVERY_VERSION_TOKEN)].some(
    ([, other]) => other !== undefined && canonicalVersion(other) !== version,
  );
  if (namesOtherVersion) return false;
  if (SUBTITLE.test(tail)) return true;
  const [firstWord = ''] = normalizeText(tail).split(' ');
  return firstWord === '' || ANNOUNCEMENT_WORDS.has(firstWord);
}

function productName(text: string): string {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const first = words.findIndex((word) => !LEADING_FILLER.has(word));
  if (first === -1) return '';
  const last = words.findLastIndex((word) => !TRAILING_FILLER.has(word));
  return words.slice(first, last + 1).join(' ');
}

/** `0.12.0` and `0.12` are the same release; a prerelease suffix keeps its own identity. */
function canonicalVersion(version: string): string {
  if (version.includes('-')) return version;
  const parts = version.split('.');
  let end = parts.length;
  while (end > 2 && parts[end - 1] === '0') end -= 1;
  return parts.slice(0, end).join('.');
}
