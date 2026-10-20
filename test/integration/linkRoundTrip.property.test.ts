import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { linkCheck } from '../../src/checks/linkCheck';
import { renderDigest } from '../../src/render/markdown';
import { canonicalLink } from '../../src/sources/adapters/entries/canonicalLink';
import { makeDigest, makeItem } from '../builders';

// The renderer writes a collected link into `[title](url)`; the link check reads it back and must
// find the collected URL. They once disagreed on a URL with `it's-here`, `a)b`, `&amp;` or a final
// full stop, and the week ended `blocked`. `canonicalLink` is the cure, applied where the item is
// built. This test states the property for every URL, not for the dozen someone thought of.
//
// A failure prints the seed and the shrunk counterexample; re-run with `{ seed, path }` from the
// report (fast-check's `replay` parameters) to reproduce it. `FAST_CHECK_RUNS=20000 pnpm vitest run
// test/integration/linkRoundTrip.property.test.ts` searches harder than the default 100 runs.
const DEFAULT_RUNS = 100;
const RUNS = Number(process.env['FAST_CHECK_RUNS']) || DEFAULT_RUNS;
const MS_PER_RUN = 2;
const TIMEOUT_MS = Math.max(5_000, RUNS * MS_PER_RUN);
fc.configureGlobal({ numRuns: RUNS });

/** The characters Markdown, HTML or a bare-URL scanner may read as structure or as the sentence. */
const STRUCTURAL = [
  ...['(', ')', '[', ']', '<', '>', "'", '"', '|', '\\', '`'],
  ...['.', ',', ';', ':', '!', '?', '&', '*', '_', '~'],
] as const;
const ENTITY_LIKE = ['&amp;', '&lt;', '&#39;', '&#x41;', '&quot;', '&unknown;'] as const;

/** What else a feed can carry: references, escapes, whitespace and invisible characters. */
const ODD = [
  '%',
  '%2',
  '%zz',
  '//',
  '&#',
  '&#x',
  ' ',
  '\t',
  '\n',
  '\u200b',
  '\u2028',
  '\u{E0041}',
] as const;

const piece = fc.oneof(
  fc.constantFrom(...STRUCTURAL),
  fc.constantFrom(...ENTITY_LIKE),
  fc.constantFrom(...ODD),
  fc.stringMatching(/^[a-z0-9]{1,3}$/),
  fc.string({ unit: 'grapheme', maxLength: 3 }),
);

/** Where the origin ends: pieces go after it, so the host stays a host. */
function pathStart(url: string): number {
  const schemeEnd = url.indexOf('://') + '://'.length;
  const slash = url.indexOf('/', schemeEnd);
  return slash === -1 ? url.length : slash;
}

/** A web URL with a path, query and fragment, sprinkled with structural characters. */
const hostileWebUrl = fc
  .tuple(
    fc.webUrl({ withQueryParameters: true, withFragments: true }),
    fc.array(fc.tuple(fc.nat(), piece), { maxLength: 6 }),
    fc.array(piece, { maxLength: 2 }),
  )
  .map(
    ([url, inserts, ending]) =>
      [...inserts].reduce((current, [offset, text]) => {
        const start = pathStart(current);
        const at = start + (offset % (current.length - start + 1));
        return `${current.slice(0, at)}${text}${current.slice(at)}`;
      }, url) + ending.join(''),
  );

const MAX_URL_CHARS = 2_048;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** What the feed adapter does with an entry link (`itemLink` in normalizeEntry.ts). */
function keptLink(raw: string): string | undefined {
  const url = canonicalLink(raw);
  return url.length <= MAX_URL_CHARS && isHttpUrl(url) ? url : undefined;
}

describe('a collected link, rendered into the digest and read back by the link check', () => {
  it(
    'is accepted, whatever characters the feed put in it',
    () => {
      fc.assert(
        fc.property(hostileWebUrl, (raw) => {
          const url = keptLink(raw);
          fc.pre(url !== undefined);
          const items = [makeItem(), makeItem({ url }), makeItem()];
          const digest = makeDigest(items);

          const markdown = renderDigest(digest, { disabledGuards: [] });
          const result = linkCheck(digest, markdown, items);

          expect(result.problems).toEqual([]);
          expect(result.ok).toBe(true);
        }),
      );
    },
    TIMEOUT_MS,
  );

  it(
    'is accepted when it is the only link of the week',
    () => {
      fc.assert(
        fc.property(hostileWebUrl, (raw) => {
          const url = keptLink(raw);
          fc.pre(url !== undefined);
          const items = [makeItem({ url })];
          const digest = makeDigest(items);

          const result = linkCheck(digest, renderDigest(digest, { disabledGuards: [] }), items);

          expect(result.problems).toEqual([]);
        }),
      );
    },
    TIMEOUT_MS,
  );
});

describe('canonicalLink', () => {
  it(
    'can be applied twice: the second pass changes nothing',
    () => {
      fc.assert(
        fc.property(hostileWebUrl, (raw) => {
          const once = canonicalLink(raw);

          expect(canonicalLink(once)).toBe(once);
        }),
      );
    },
    TIMEOUT_MS,
  );
});
