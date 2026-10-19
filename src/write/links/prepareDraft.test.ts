import { describe, expect, it, vi } from 'vitest';
import { linkCheck } from '../../checks/linkCheck';
import { renderDigest } from '../../render/markdown';
import type { Digest, DigestItem, Draft, Item } from '../../domain/schemas';
import type { ScoredItem } from '../../classify/classification';
import { prepareDraft, prepareWithCount } from './prepareDraft';
import { MAX_LINK_CHARS, MAX_TRAILING_CHARS } from './withSchemes';
import type * as UrlModule from '../../shared/url';
import { normalizeUrl } from '../../shared/url';
import { makeDigest, makeDigestItem, makeItem, makeScoredItem } from '../../../test/builders';

// The real normalizeUrl, counted: the work per token has to stay bounded.
vi.mock('../../shared/url', async (importOriginal) => {
  const actual = await importOriginal<typeof UrlModule>();
  return { ...actual, normalizeUrl: vi.fn(actual.normalizeUrl) };
});

const DOCKER_URL = 'https://www.docker.com/blog/docker-sandbox-kit-spec-cncf/';
const DOCKER_LINK = 'www.docker.com/blog/docker-sandbox-kit-spec-cncf/';
const WIKI_URL = 'https://wiki.example.org/Foo_(bar)';
const EM_DASH = '—';

function makeItems(): ScoredItem[] {
  return [
    makeScoredItem({ url: DOCKER_URL, title: 'Docker sandbox kit spec' }),
    makeScoredItem({ url: 'https://example.com/posts/b', title: 'Release B' }),
    makeScoredItem({ url: WIKI_URL, title: 'Wiki release' }),
    makeScoredItem({ url: 'http://plain.example.net/a', title: 'Plain http release' }),
    makeScoredItem({ url: 'https://docs.example.org/guide', title: 'Guide' }),
  ];
}

/** A draft over `items` with `fields` overriding the text of the first digest item. */
function draftWith(
  items: readonly Item[],
  fields: Partial<DigestItem> = {},
  digest: Partial<Digest> = {},
): Draft {
  const base = makeDigest(items, digest);
  const [first, ...rest] = base.items;
  return { writer: 'writer-a', digest: { ...base, items: [{ ...first!, ...fields }, ...rest] } };
}

const summaryOf = (draft: Draft): string => draft.digest.items[0]?.summary ?? '';

const checkOf = (draft: Draft, items: readonly Item[]) =>
  linkCheck(draft.digest, renderDigest(draft.digest, { disabledGuards: [] }), items);

describe('prepareDraft: a link without https:// that names a collected item (W5-11)', () => {
  const items = makeItems();
  const collected = items.map((item) => item.url);
  const prepare = (draft: Draft): Draft => prepareDraft(draft, 5, collected);

  it('adds the scheme to a www link, using the collected url as written', () => {
    const draft = draftWith(items, { summary: `Details at ${DOCKER_LINK} today.` });

    expect(summaryOf(prepare(draft))).toBe(`Details at ${DOCKER_URL} today.`);
  });

  it('adds the scheme to a protocol-relative link', () => {
    const draft = draftWith(items, { summary: `Details at //${DOCKER_LINK} today.` });

    expect(summaryOf(prepare(draft))).toBe(`Details at ${DOCKER_URL} today.`);
  });

  it('fixes the link text and the destination of a Markdown link that both name a collected url', () => {
    const draft = draftWith(items, {
      summary: `[${DOCKER_LINK}](${DOCKER_LINK}) and [${DOCKER_LINK}](${DOCKER_URL})`,
    });

    expect(summaryOf(prepare(draft))).toBe(
      `[${DOCKER_URL}](${DOCKER_URL}) and [${DOCKER_URL}](${DOCKER_URL})`,
    );
  });

  it('starts after a brace, an angle bracket or a single quote too', () => {
    const draft = draftWith(items, {
      summary: `{${DOCKER_LINK}} <${DOCKER_LINK}> '${DOCKER_LINK}' >${DOCKER_LINK}`,
    });

    expect(summaryOf(prepare(draft))).toBe(
      `{${DOCKER_URL}} <${DOCKER_URL}> '${DOCKER_URL}' >${DOCKER_URL}`,
    );
  });

  it('starts at the beginning of the text, after an opening bracket, a quote or emphasis', () => {
    const draft = draftWith(items, {
      summary: `${DOCKER_LINK} [${DOCKER_LINK}] "${DOCKER_LINK}" _${DOCKER_LINK}_ ~${DOCKER_LINK}`,
    });

    expect(summaryOf(prepare(draft))).toBe(
      `${DOCKER_URL} [${DOCKER_URL}] "${DOCKER_URL}" _${DOCKER_URL}_ ~${DOCKER_URL}`,
    );
  });

  it('keeps the closing bracket of a Markdown link and the punctuation after a bare link', () => {
    const draft = draftWith(items, {
      summary: `[the spec](${DOCKER_LINK}) and (see ${DOCKER_LINK}). Also *${DOCKER_LINK}*, ${DOCKER_LINK}!`,
    });

    expect(summaryOf(prepare(draft))).toBe(
      `[the spec](${DOCKER_URL}) and (see ${DOCKER_URL}). Also *${DOCKER_URL}*, ${DOCKER_URL}!`,
    );
  });

  it('matches the way the link check does: host case, trailing slash, tracking parameters', () => {
    const draft = draftWith(items, {
      summary: `A WWW.Docker.com/blog/docker-sandbox-kit-spec-cncf and B ${DOCKER_LINK}?utm_source=x#top`,
    });

    expect(summaryOf(prepare(draft))).toBe(`A ${DOCKER_URL} and B ${DOCKER_URL}`);
  });

  it('keeps a url with balanced parentheses whole', () => {
    const draft = draftWith(items, { summary: 'See //wiki.example.org/Foo_(bar) now.' });

    expect(summaryOf(prepare(draft))).toBe(`See ${WIKI_URL} now.`);
  });

  it('rewrites every text field, not only the summary', () => {
    const draft = draftWith(
      items,
      {
        title: `T ${DOCKER_LINK}`,
        area: `A ${DOCKER_LINK}`,
        summary: `S ${DOCKER_LINK}`,
        whyItMatters: `W ${DOCKER_LINK}`,
      },
      { headline: `H ${DOCKER_LINK}`, intro: `I ${DOCKER_LINK}` },
    );

    const { digest } = prepare(draft);

    expect(digest.headline).toBe(`H ${DOCKER_URL}`);
    expect(digest.intro).toBe(`I ${DOCKER_URL}`);
    expect(digest.items[0]).toMatchObject({
      title: `T ${DOCKER_URL}`,
      area: `A ${DOCKER_URL}`,
      summary: `S ${DOCKER_URL}`,
      whyItMatters: `W ${DOCKER_URL}`,
    });
  });

  it.each([
    ['a host that was never collected', 'See www.evil.example/payload now.'],
    ['a longer path than the collected url', `See ${DOCKER_LINK}evil now.`],
    ['a collected host with another path', 'See www.docker.com/blog/something-else now.'],
    ['a protocol-relative link to another host', 'See //evil.example/a now.'],
    ['a link to an http collected url, since only https:// is added', 'See //plain.example.net/a'],
    ['a collected host whose name only starts the same', 'See www.docker.com.evil.example/x now.'],
    ['a collected host with credentials in front', 'See www.docker.com@evil.example/x now.'],
    ['a bare host without www', 'See docker.com/blog/docker-sandbox-kit-spec-cncf/ now.'],
    ['a name that ends in www., not starting one', `Ask foo@${DOCKER_LINK} now.`],
    ['a link glued to a word', `See x${DOCKER_LINK} now.`],
    [
      'a link inside the query of a url',
      'See https://example.com/r?u=//docs.example.org/guide now.',
    ],
    ['a link inside the fragment of a url', `See https://example.com/a#${DOCKER_LINK} now.`],
    ['a link after an equals sign', `See <a href=${DOCKER_LINK}>x</a> now.`],
  ])('leaves %s as the writer wrote it', (_name, summary) => {
    const draft = draftWith(items, { summary });

    expect(summaryOf(prepare(draft))).toBe(summary);
  });

  it('leaves a scheme-less link that is not a collected url for the link check to reject', () => {
    const draft = draftWith(items, {
      summary: 'See www.evil.example/payload and //evil.example/a.',
    });

    const problems = checkOf(prepare(draft), items).problems.join('\n');

    expect(problems).toContain('www.evil.example/payload');
    expect(problems).toContain('//evil.example/a');
  });

  it('does not touch a link that already has its scheme', () => {
    const summary = `Read ${DOCKER_URL} and https://example.com//a and [x](${DOCKER_URL}).`;
    const draft = draftWith(items, { summary });

    expect(summaryOf(prepare(draft))).toBe(summary);
  });

  it('leaves text with nothing link-like alone, and rewrites nothing without collected urls', () => {
    const plain = draftWith(items, { summary: 'No links here, only words and a/b paths.' });
    const linked = draftWith(items, { summary: `See ${DOCKER_LINK}` });

    expect(prepare(plain)).toEqual(plain);
    expect(prepareDraft(linked, 5, [])).toEqual(linked);
  });

  it('never leaves a url with a scheme that is neither a collected url nor was in the draft', () => {
    const hostile = [
      'www.evil.example/a',
      '//evil.example/b',
      `${DOCKER_LINK}../../evil`,
      `${DOCKER_LINK})https://evil.example`,
      'WWW.docker.com@evil.example/x',
      'www.docker.com.evil.example/blog/docker-sandbox-kit-spec-cncf/',
    ].join(' ');
    const draft = draftWith(items, { summary: `${hostile} ${DOCKER_LINK}` });
    const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s)]+/g) ?? [];

    const urls = urlsIn(summaryOf(prepare(draft)));

    expect(urls).toContain(DOCKER_URL);
    for (const url of urls) expect([...collected, ...urlsIn(summaryOf(draft))]).toContain(url);
  });

  it('does not change the draft it was given', () => {
    const draft = draftWith(items, { summary: `See ${DOCKER_LINK}` });
    const snapshot = structuredClone(draft);

    prepare(draft);

    expect(draft).toEqual(snapshot);
  });

  describe('bounds', () => {
    const trailing = (count: number): string => ')'.repeat(count);

    it(`takes up to ${MAX_TRAILING_CHARS} closing characters off the end, and no more`, () => {
      const within = draftWith(items, {
        summary: `[x](${DOCKER_LINK}${trailing(MAX_TRAILING_CHARS)}`,
      });
      const beyond = draftWith(items, {
        summary: `[x](${DOCKER_LINK}${trailing(MAX_TRAILING_CHARS + 1)}`,
      });

      expect(summaryOf(prepare(within))).toBe(`[x](${DOCKER_URL}${trailing(MAX_TRAILING_CHARS)}`);
      expect(summaryOf(prepare(beyond))).toBe(summaryOf(beyond));
    });

    it(`looks up a token of ${MAX_LINK_CHARS} characters, and not one a character longer`, () => {
      const stem = 'www.long.example/';
      const url = (length: number): string => `https://${stem}${'a'.repeat(length - stem.length)}`;
      const at = url(MAX_LINK_CHARS);
      const over = url(MAX_LINK_CHARS + 1);
      const text = (link: string): string => `See ${link.slice('https://'.length)} now.`;
      const urls = [...collected, at, over];

      const atCap = prepareDraft(draftWith(items, { summary: text(at) }), 5, urls);
      const overCap = prepareDraft(draftWith(items, { summary: text(over) }), 5, urls);

      expect(summaryOf(atCap)).toBe(`See ${at} now.`);
      expect(summaryOf(overCap)).toBe(text(over));
    });

    it('does a bounded number of lookups for a text full of hostile tokens', () => {
      const token = `www.x${trailing(100)}`;
      const count = 1_000;
      const draft = draftWith(items, { summary: Array(count).fill(token).join(' ') });
      vi.mocked(normalizeUrl).mockClear();

      prepare(draft);

      const lookups = vi.mocked(normalizeUrl).mock.calls.length;
      expect(lookups).toBeLessThanOrEqual(count * (MAX_TRAILING_CHARS + 1) + collected.length);
    });

    it('skips a token longer than the cap without a lookup', () => {
      const draft = draftWith(items, {
        summary: `a www.${')'.repeat(60_000)} b //${'.'.repeat(60_000)} c www.${'x.'.repeat(30_000)}`,
      });
      vi.mocked(normalizeUrl).mockClear();

      prepare(draft);

      expect(vi.mocked(normalizeUrl).mock.calls.length).toBe(collected.length);
    });
  });
});

function makeTitledItems(count = 4): ScoredItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeScoredItem({ title: `Tool ${i + 1} ships`, summary: `Tool ${i + 1} adds a feature.` }),
  );
}

describe('prepareDraft: the draft as a whole (W5-06)', () => {
  const draftOf = (count: number, overrides: Partial<Digest> = {}): Draft => ({
    writer: 'writer-a',
    digest: makeDigest(makeTitledItems(count), overrides),
  });

  it('keeps at most topN items and does not change the draft it was given', () => {
    const draft = draftOf(5);
    const snapshot = structuredClone(draft);

    const prepared = prepareDraft(draft, 3, []);

    expect(prepared.digest.items).toHaveLength(3);
    expect(prepared.writer).toBe('writer-a');
    expect(draft).toEqual(snapshot);
  });

  it('replaces a run of em dashes with one comma, and drops them at the ends of a field', () => {
    const prepared = prepareDraft(
      draftOf(3, {
        headline: `${EM_DASH} Runners, ${EM_DASH} gateways ${EM_DASH}`,
        intro: `Fast ${EM_DASH}${EM_DASH} faster`,
      }),
      5,
      [],
    );

    expect(prepared.digest.headline).toBe('Runners, gateways');
    expect(prepared.digest.intro).toBe('Fast, faster');
  });

  it('cleans every text field of every item', () => {
    const [first, ...rest] = makeTitledItems(3);
    const dirty = makeDigestItem(first!, {
      title: `A ${EM_DASH} B`,
      area: `C ${EM_DASH} D`,
      summary: `E ${EM_DASH} F`,
      whyItMatters: `G ${EM_DASH} H`,
    });
    const items = [dirty, ...rest.map((item) => makeDigestItem(item))];

    const [item] = prepareDraft({ writer: 'w', digest: makeDigest([], { items }) }, 5, []).digest
      .items;

    expect(item).toMatchObject({
      title: 'A, B',
      area: 'C, D',
      summary: 'E, F',
      whyItMatters: 'G, H',
    });
  });
});

describe('prepareDraft on the action line (W8-01)', () => {
  const source = makeItem({ url: 'https://example.com/posts/1' });
  const prepared = (patch: Partial<DigestItem>): DigestItem => {
    const draft = {
      writer: 'w',
      digest: makeDigest([source], { items: [makeDigestItem(source, patch)] }),
    };
    return prepareDraft(draft, 5, [source.url]).digest.items[0]!;
  };

  it('replaces an em dash in the action, like in every other field', () => {
    expect(prepared({ action: 'Upgrade now — before Friday' }).action).toBe(
      'Upgrade now, before Friday',
    );
  });

  it('does not repair a link in the action: the format check rejects any link there', () => {
    expect(prepared({ action: 'Read //example.com/posts/1 first' }).action).toBe(
      'Read //example.com/posts/1 first',
    );
  });

  it('cuts an action longer than the schema allows, so the draft can be stored', () => {
    const action = prepared({ action: 'word '.repeat(100) }).action ?? '';

    expect(action.length).toBeLessThanOrEqual(200);
    expect(action.endsWith('...')).toBe(true);
  });

  it('leaves an item without an action without one', () => {
    expect(prepared({ urgency: 'good-to-know' }).action).toBeUndefined();
  });

  it('keeps urgency, and does not change the input item', () => {
    const item = makeDigestItem(source, { urgency: 'act-now', action: 'Upgrade — now' });
    const draft = { writer: 'w', digest: makeDigest([source], { items: [item] }) };

    const out = prepareDraft(draft, 5, []);

    expect(out.digest.items[0]?.urgency).toBe('act-now');
    expect(item.action).toBe('Upgrade — now');
  });
});

describe('prepareWithCount', () => {
  const items = makeItems();
  const collected = items.map((item) => item.url);

  it('counts each link it gave a scheme, across every field', () => {
    const draft = draftWith(
      items,
      { summary: `A ${DOCKER_LINK} and //example.com/posts/b.`, title: `T ${DOCKER_LINK}` },
      { headline: `H ${DOCKER_LINK}` },
    );

    const { repairedLinks } = prepareWithCount(draft, 5, collected);

    expect(repairedLinks).toBe(4);
  });

  it('counts nothing when no link needed a scheme, or the link is not a collected url', () => {
    const clean = draftWith(items, { summary: `Read ${DOCKER_URL} now.` });
    const foreign = draftWith(items, { summary: 'Read www.evil.example/x now.' });

    expect(prepareWithCount(clean, 5, collected).repairedLinks).toBe(0);
    expect(prepareWithCount(foreign, 5, collected).repairedLinks).toBe(0);
  });

  it('returns the draft prepareDraft returns', () => {
    const draft = draftWith(items, { summary: `A ${DOCKER_LINK} ${EM_DASH} done` });

    expect(prepareWithCount(draft, 3, collected).draft).toEqual(prepareDraft(draft, 3, collected));
  });
});
