import { describe, expect, it } from 'vitest';
import { SourceSchema, type Source } from '../../../domain/schemas';
import { DigestError } from '../../../shared/errors';
import { scriptedPrompts } from '../../init/__fixtures__/initHarness';
import {
  askNewSources,
  detectKind,
  parseSourceList,
  sourceIdFor,
  sourcesOrThrow,
} from './newSources';

const existing: Source[] = [
  { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' },
];

describe('detectKind', () => {
  it.each([
    ['https://github.com/ollama/ollama', 'github'],
    ['https://www.github.com/ollama/ollama', 'github'],
    ['https://github.com/ollama', 'rss'],
    ['https://github.com/ollama/ollama/releases.atom', 'rss'],
    ['https://blog.example.com/feed.xml', 'rss'],
    ['not a url', 'rss'],
  ] as const)('%s is %s', (url, kind) => {
    expect(detectKind(url)).toBe(kind);
  });
});

describe('sourceIdFor', () => {
  it('slugs the host and path to the schema id shape', () => {
    const id = sourceIdFor('https://www.Blog.Example.com/Posts/Feed.xml?x=1', new Set());

    expect(id).toBe('blog-example-com-posts-feed-xml');
    expect(SourceSchema.shape.id.safeParse(id).success).toBe(true);
  });

  it('adds -2, -3 on a clash', () => {
    const taken = new Set(['example-com-feed', 'example-com-feed-2']);

    expect(sourceIdFor('https://example.com/feed', taken)).toBe('example-com-feed-3');
  });

  it('keeps an id within 60 characters and without a trailing dash', () => {
    const id = sourceIdFor(`https://example.com/${'a-'.repeat(60)}`, new Set());

    expect(id.length).toBeLessThanOrEqual(60);
    expect(id.endsWith('-')).toBe(false);
  });

  it('falls back to a plain id for text with no letters', () => {
    expect(sourceIdFor('!!!', new Set())).toBe('source');
  });
});

describe('parseSourceList', () => {
  it('builds sources with a kind and an id each', () => {
    const parsed = parseSourceList(
      'https://github.com/acme/widgets, https://acme.dev/blog/rss.xml',
      existing,
    );

    expect(parsed).toEqual([
      { id: 'github-com-acme-widgets', kind: 'github', url: 'https://github.com/acme/widgets' },
      { id: 'acme-dev-blog-rss-xml', kind: 'rss', url: 'https://acme.dev/blog/rss.xml' },
    ]);
  });

  it('gives a clashing id a suffix, also within one list', () => {
    const parsed = parseSourceList(
      'https://example.com/feed.xml?a=1, https://example.com/feed.xml?a=2',
      [],
    );

    expect(parsed).toMatchObject([
      { id: 'example-com-feed-xml' },
      { id: 'example-com-feed-xml-2' },
    ]);
  });

  it.each([
    ['', /at least one/],
    ['ftp://example.com/feed', /not an http\(s\) URL/],
    ['example.com/feed', /not an http\(s\) URL/],
    ['https://example.com/feed.xml', /already a source/],
    ['https://example.com/feed.xml#top', /already a source/],
    ['https://new.example.com/a, https://new.example.com/a', /already a source/],
  ])('refuses %j', (text, message) => {
    expect(parseSourceList(text, existing)).toMatch(message);
  });
});

describe('askNewSources', () => {
  it('asks for comma-separated URLs and returns the sources', async () => {
    const { prompts, calls } = scriptedPrompts([
      [/Source URLs/, 'https://github.com/acme/widgets'],
    ]);

    const added = await askNewSources(prompts, existing);

    expect(calls[0]?.message).toBe('Source URLs (comma-separated)');
    expect(added.map((source) => source.id)).toEqual(['github-com-acme-widgets']);
  });

  it('has the prompt refuse a duplicate before it is accepted', async () => {
    const { prompts, calls } = scriptedPrompts([[/Source URLs/, 'https://new.example.com/feed']]);
    await askNewSources(prompts, existing);

    const validate = calls[0]?.options.validate;

    expect(validate?.('https://example.com/feed.xml')).toMatch(/already a source/);
    expect(validate?.('https://new.example.com/other')).toBe(true);
  });
});

describe('sourcesOrThrow', () => {
  it('stops the run with a DigestError naming the flag', () => {
    expect(() => sourcesOrThrow('nope', existing)).toThrow(DigestError);
    expect(() => sourcesOrThrow('nope', existing)).toThrow(/Invalid --add-source/);
  });
});
