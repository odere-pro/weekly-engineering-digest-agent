import { withoutTrailingDots } from '../tidy/title';

// The facts a reader acts on: versions, advisory ids and dates. The writer must not invent or
// change one, and `missingFacts` is how a check or an eval finds out that it did.
//
// Model output is hostile, so every pattern is linear: each one starts at a character no earlier
// match could have used, and none has a quantifier inside a quantifier that can fail afterwards.
// A pre-release is one of a few known words (`-rc.1`, `.preview1`, `beta`) or an `a`/`b` and a
// number glued to the version (`3.12.0b1`). Any other hyphenated word is a name (`gpt-4.1-mini`).
const PRE_RELEASE = String.raw`(?:[-.]?(?:alpha|beta|preview|pre|rc|dev|snapshot|nightly|canary)(?![a-z])\d*(?:\.\d+)*|[ab]\d+)`;
const VERSION = String.raw`(?<![\d.])v?\d+(?:\.\d+){1,3}${PRE_RELEASE}?`;
const CVE = String.raw`cve-\d{4}-\d{4,}`;
const ADVISORY = String.raw`ghsa(?:-[a-z0-9]{4}){3}(?![a-z0-9])`;
const DATE = String.raw`(?<!\d)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)`;
const FACT = new RegExp([VERSION, CVE, ADVISORY, DATE].join('|'), 'gi');

/** The source text a written text is checked against. */
export interface FactSource {
  title: string;
  summary?: string;
}

/**
 * The normal form: lowercase, no `v` before a digit, no closing dot. No pattern above can end in a
 * dot today; cutting it keeps `V1.2.0` and `1.2.0.` one fact if a pattern ever can.
 */
function normalised(match: string): string {
  return withoutTrailingDots(match.toLowerCase()).replace(/^v(?=\d)/, '');
}

/**
 * The version numbers, CVE and GHSA ids and ISO dates in `text`, normalised, each once, in the
 * order they first appear. A version has two to four numbers and may end in a pre-release such
 * as `-rc.1` or `b1`; `2.0.0-rc.1` and `2.0.0` are different facts, and `4.1-mini` is `4.1`.
 */
export function factTokensOf(text: string): string[] {
  return [...new Set([...text.matchAll(FACT)].map(([match]) => normalised(match)))];
}

/** A version with no pre-release: digits and dots only, like `1.31`. */
const PLAIN_VERSION = /^\d+(?:\.\d+)+$/;

/**
 * The shorter forms of the plain versions in `facts`: `1.31` for `1.31.2`, `1.31` and `1.31.2`
 * for `1.31.2.1`. A version with a pre-release gives none: "1.17" for `1.17.0-beta1` would
 * announce a beta as the release.
 */
function shorterVersions(facts: ReadonlySet<string>): Set<string> {
  const shorter = new Set<string>();
  for (const fact of facts) {
    if (!PLAIN_VERSION.test(fact)) continue;
    const numbers = fact.split('.');
    for (let length = 2; length < numbers.length; length += 1) {
      shorter.add(numbers.slice(0, length).join('.'));
    }
  }
  return shorter;
}

/**
 * The facts in `written` that neither the source title nor the source summary has, in the order
 * of the text. The two source parts are read apart, so no fact is built across their join.
 *
 * A written text may name a shorter version than the source ("Kubernetes 1.31" for "v1.31.2" is
 * not wrong), so a plain version that is a shorter form of a plain source version is not missing.
 * A pre-release must match exactly: "1.17" and "1.17.0" are missing for a source "1.17.0-beta1".
 * The title repair (`groundTitle`) and the eval metric `factCarry` both read this, so the
 * pipeline and the measure cannot disagree on what a wrong fact is.
 */
export function missingFacts(written: string, source: FactSource): string[] {
  const known = new Set([...factTokensOf(source.title), ...factTokensOf(source.summary ?? '')]);
  const missing = factTokensOf(written).filter((token) => !known.has(token));
  if (missing.length === 0) return missing;
  const shorter = shorterVersions(known);
  return missing.filter((token) => !shorter.has(token));
}
