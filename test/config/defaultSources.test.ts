import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../src/config/defaultSources.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { SourceSchema } from '../../src/core/schemas.js';

const AREAS = ['ai-models', 'ai-tooling', 'platform', 'cloud'];
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface DocRow {
  url: string;
  kind: string;
  area: string;
}

/** Rows of the "Sources" table in docs/sources.md, keyed by source id. */
function readDocRows(doc: string): Map<string, DocRow> {
  const rows = new Map<string, DocRow>();
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = /^`([a-z0-9-]+)`$/.exec(cells[1] ?? '')?.[1];
    if (id !== undefined) {
      rows.set(id, { url: cells[2] ?? '', kind: cells[3] ?? '', area: cells[4] ?? '' });
    }
  }
  return rows;
}

/** Backticked hosts in the paragraph that starts "Only these hosts". */
function readDocHosts(doc: string): string[] {
  const paragraph = doc.split('\n\n').find((p) => p.startsWith('Only these hosts')) ?? '';
  return [...paragraph.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

describe('DEFAULT_SOURCES', () => {
  it('parses every source with SourceSchema', () => {
    for (const source of DEFAULT_SOURCES) {
      expect(SourceSchema.safeParse(source).success, source.id).toBe(true);
    }
  });

  it('has unique ids and unique URLs, ignoring case', () => {
    const ids = DEFAULT_SOURCES.map((s) => s.id);
    const urls = DEFAULT_SOURCES.map((s) => s.url.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('lists 15-25 sources', () => {
    expect(DEFAULT_SOURCES.length).toBeGreaterThanOrEqual(15);
    expect(DEFAULT_SOURCES.length).toBeLessThanOrEqual(25);
  });

  it('uses https for every URL', () => {
    for (const source of DEFAULT_SOURCES) {
      expect(new URL(source.url).protocol, source.id).toBe('https:');
    }
  });

  it('gives github sources a bare repository URL', () => {
    const github = DEFAULT_SOURCES.filter((s) => s.kind === 'github');
    expect(github.length).toBeGreaterThan(0);
    for (const source of github) {
      expect(source.url, source.id).toMatch(GITHUB_REPO_URL);
      expect(source.url, source.id).not.toMatch(/\.git$/);
    }
  });

  it('keeps rss sources off github.com', () => {
    for (const source of DEFAULT_SOURCES.filter((s) => s.kind === 'rss')) {
      expect(new URL(source.url).hostname, source.id).not.toBe('github.com');
    }
  });

  it('gives every source an area from the known set', () => {
    for (const source of DEFAULT_SOURCES) {
      expect(AREAS, source.id).toContain(source.area);
    }
  });

  it('covers every area, so AI and platform engineering are both represented', () => {
    const used = new Set(DEFAULT_SOURCES.map((s) => s.area));
    for (const area of AREAS) {
      expect(used.has(area), area).toBe(true);
    }
  });
});

describe('digest.config.example.json', () => {
  it('parses with ConfigSchema', () => {
    expect(ConfigSchema.safeParse(readJson('digest.config.example.json')).success).toBe(true);
  });

  it('lists exactly DEFAULT_SOURCES and DEFAULT_FOCUS_AREAS, with no extra keys', () => {
    const raw = z
      .object({ sources: z.array(z.unknown()), focusAreas: z.array(z.string()) })
      .parse(readJson('digest.config.example.json'));
    expect(raw.sources).toEqual([...DEFAULT_SOURCES]);
    expect(raw.focusAreas).toEqual([...DEFAULT_FOCUS_AREAS]);
  });
});

describe('docs/sources.md', () => {
  const doc = readFileSync('docs/sources.md', 'utf8');

  it('has one table row per default source with the same url, kind and area', () => {
    const rows = readDocRows(doc);
    expect([...rows.keys()].sort()).toEqual(DEFAULT_SOURCES.map((s) => s.id).sort());
    for (const source of DEFAULT_SOURCES) {
      expect(rows.get(source.id), source.id).toEqual({
        url: source.url,
        kind: source.kind,
        area: source.area,
      });
    }
  });

  it('states the number of default sources', () => {
    expect(doc).toContain(`The ${String(DEFAULT_SOURCES.length)} feeds in`);
  });

  it('lists exactly the hosts the default sources contact', () => {
    const hosts = new Set(DEFAULT_SOURCES.map((s) => new URL(s.url).hostname));
    expect(readDocHosts(doc).sort()).toEqual([...hosts].sort());
  });
});
