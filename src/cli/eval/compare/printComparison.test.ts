// printComparison: `digest eval --compare <a> <b>` reads two saved scorecards and prints the table.
import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { makeScorecard } from '../__fixtures__/scorecardKit';
import { printComparison, type CompareIo } from './printComparison';

const CARD_A = JSON.stringify(makeScorecard('light', { classifierAccuracy: { value: 0.7 } }));
const CARD_B = JSON.stringify(makeScorecard('light', { classifierAccuracy: { value: 0.85 } }));

function setup(files: Record<string, string>) {
  const out: string[] = [];
  const read: string[] = [];
  const io: CompareIo = {
    readFile: (path) => {
      read.push(path);
      const text = files[path];
      return text === undefined ? Promise.reject(new Error(`no ${path}`)) : Promise.resolve(text);
    },
    stdout: (text) => out.push(text),
  };
  return { io, out, read };
}

describe('printComparison', () => {
  it('reads both files and prints the comparison, ending with a newline', async () => {
    const t = setup({ 'a.json': CARD_A, 'b.json': CARD_B });

    await printComparison(['a.json', 'b.json'], t.io);

    expect(t.read).toEqual(['a.json', 'b.json']);
    expect(t.out).toHaveLength(1);
    expect(t.out[0]).toContain('Eval compare: A = a.json (light, 2026-10-16)');
    expect(t.out[0]).toMatch(/Classifier accuracy\s+70\.0%\s+85\.0%/);
    expect(t.out[0]?.endsWith('\n')).toBe(true);
  });

  it.each([[[]], [['a.json']], [['a.json', 'b.json', 'c.json']]])(
    'needs exactly two files, not %j',
    async (paths) => {
      const t = setup({});

      const failure = printComparison(paths, t.io);

      await expect(failure).rejects.toBeInstanceOf(DigestError);
      await expect(failure).rejects.toThrow(
        '--compare needs two scorecard files: --compare <a.json> <b.json>',
      );
      expect(t.read).toEqual([]);
    },
  );

  it('names a file it cannot read and keeps the cause', async () => {
    const t = setup({ 'b.json': CARD_B });

    const failure = printComparison(['gone.json', 'b.json'], t.io);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow('Cannot read gone.json: no gone.json');
    await expect(failure).rejects.toHaveProperty('cause', new Error('no gone.json'));
    expect(t.out).toEqual([]);
  });

  it('names a file that is not valid JSON, and prints nothing', async () => {
    const t = setup({ 'a.json': '{not json', 'b.json': CARD_B });

    await expect(printComparison(['a.json', 'b.json'], t.io)).rejects.toThrow(
      'a.json is not valid JSON',
    );
    expect(t.out).toEqual([]);
  });

  it('names a file that is not a scorecard', async () => {
    const t = setup({ 'a.json': CARD_A, 'b.json': '{}' });

    await expect(printComparison(['a.json', 'b.json'], t.io)).rejects.toThrow(
      'b.json is not a scorecard',
    );
    expect(t.out).toEqual([]);
  });
});
