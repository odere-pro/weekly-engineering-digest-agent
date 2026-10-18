// Golden Markdown for recorded digests, and the always-on checks run over the same fixtures.
// Goldens are .golden.txt: prettier rewrites the table pipes of a .md file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatCheck } from '../checks/formatCheck';
import { linkCheck } from '../checks/linkCheck';
import { renderDigest } from './markdown';
import { DigestSchema } from '../domain/schemas';
import { GuardCheckIdSchema } from '../guards/guardVerdict';
import { z } from 'zod';
import { makeItem } from '../../test/builders';
import { splitCells } from './__fixtures__/render/cells';

const FixtureSchema = z.object({
  disabledGuards: z.array(GuardCheckIdSchema),
  digest: DigestSchema,
});

const NAMES = ['mixed', 'old-draft', 'quiet-week', 'escaping'] as const;

const read = (file: string): string =>
  readFileSync(new URL(`./__fixtures__/render/${file}`, import.meta.url), 'utf8');

function load(name: string) {
  const { digest, disabledGuards } = FixtureSchema.parse(JSON.parse(read(`${name}.digest.json`)));
  return { digest, disabledGuards, markdown: renderDigest(digest, { disabledGuards }) };
}

const cellCount = (line: string): number => splitCells(line).length;

describe.each(NAMES)('render fixture %s', (name) => {
  const { digest, markdown } = load(name);

  it('renders to the golden Markdown', () => {
    expect(markdown).toBe(read(`${name}.golden.txt`));
  });

  it('passes the link check against the urls it was built from', () => {
    const collected = digest.items.map((item) => makeItem({ url: item.url, title: item.title }));

    expect(linkCheck(digest, markdown, collected)).toEqual({ ok: true, problems: [] });
  });

  it('passes the format check', () => {
    expect(formatCheck(digest, markdown)).toEqual({ ok: true, problems: [] });
  });

  it('keeps every table row as wide as its header', () => {
    const rows = markdown.split('\n').filter((line) => line.startsWith('|'));
    let width = 0;
    for (const row of rows) {
      if (row.startsWith('| Release')) width = cellCount(row);
      expect(cellCount(row)).toBe(width);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('has one table row per item', () => {
    const releaseRows = markdown.split('\n').filter((line) => line.startsWith('| ['));

    expect(releaseRows).toHaveLength(digest.items.length);
  });
});

describe('render fixtures against the link check', () => {
  it('still rejects a url the collected items do not have', () => {
    const { digest, markdown } = load('mixed');
    const collected = digest.items.slice(1).map((item) => makeItem({ url: item.url }));

    const result = linkCheck(digest, markdown, collected);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('opentofu');
  });
});
