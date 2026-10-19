// The clean control of a grounding case (the draft without the planted item) must restate its
// sources, or the groundedness guard is right to block it and `guardFalseBlocks` stops measuring
// the guard (W11-11). Deterministic: no model.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GroundingCaseSchema, type GroundingCase } from './schema';

const GROUNDING_DIR = join(import.meta.dirname, 'grounding');
/** Cases 01 to 10 are the spec set; cases 11 to 30 are the ones this rule was written for. */
const FIRST_CHECKED_CASE = 11;
/** Share of a line's words that must appear in its source item's title and summary. */
const MIN_OVERLAP = 0.85;

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function overlap(line: string, sourceText: string): number {
  const known = new Set(wordsOf(sourceText));
  const words = wordsOf(line);
  return words.length === 0 ? 0 : words.filter((word) => known.has(word)).length / words.length;
}

describe('grounding controls restate their sources', () => {
  let cases: { file: string; value: GroundingCase }[] = [];

  beforeAll(async () => {
    const files = (await readdir(GROUNDING_DIR)).filter((name) =>
      /^grounding-\d+.*\.json$/.test(name),
    );
    cases = await Promise.all(
      files.sort().map(async (file) => ({
        file,
        value: GroundingCaseSchema.parse(
          JSON.parse(await readFile(join(GROUNDING_DIR, file), 'utf8')),
        ),
      })),
    );
  });

  it('keeps every non-planted summary and whyItMatters inside its source text', () => {
    const failures: string[] = [];
    for (const { file, value } of cases) {
      if (Number(file.slice('grounding-'.length, 'grounding-'.length + 2)) < FIRST_CHECKED_CASE)
        continue;
      for (const entry of value.draft.digest.items) {
        if (entry.itemId === value.plantedItemId) continue;
        const source = value.sources.find((candidate) => candidate.id === entry.itemId);
        const sourceText = `${source?.title ?? ''} ${source?.summary ?? ''}`;
        for (const field of ['summary', 'whyItMatters'] as const) {
          const share = overlap(entry[field], sourceText);
          if (share < MIN_OVERLAP)
            failures.push(`${file} ${entry.itemId} ${field}: ${share.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('checks cases 11 to 30', () => {
    const checked = cases.filter(
      ({ file }) =>
        Number(file.slice('grounding-'.length, 'grounding-'.length + 2)) >= FIRST_CHECKED_CASE,
    );
    expect(checked).toHaveLength(20);
  });
});
