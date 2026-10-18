// The judge calibration check (W3-04 prep): hand grades against judge scores, from a JSON file.
// No model is called; the numbers come from the sheet alone.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calibrate, main, meanAbsoluteDifference, runCalibration, spearman } from './calibrate';
import { GradingSheetSchema, type GradingSheet } from './gradingSheet';
import { JudgeCalibrationSchema } from '../schema';
import { DigestError } from '../../src/shared/errors';

const pairs = (human: number[], judge: number[]) =>
  human.map((h, i) => ({ human: h, judge: judge[i] ?? 0 }));

describe('spearman', () => {
  it('is 1 for the same order, whatever the distances', () => {
    expect(spearman(pairs([1, 2, 3, 4], [2, 3, 4, 5]))).toBeCloseTo(1);
    expect(spearman(pairs([1, 2, 3, 4], [1, 1.1, 4.9, 5]))).toBeCloseTo(1);
  });

  it('is -1 for the opposite order', () => {
    expect(spearman(pairs([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]))).toBeCloseTo(-1);
  });

  it('matches the textbook value for a swap of two neighbours', () => {
    // d = [0, 0, 0, 1, -1]: 1 - 6 * 2 / (5 * 24) = 0.9
    expect(spearman(pairs([1, 2, 3, 4, 5], [1, 2, 3, 5, 4]))).toBeCloseTo(0.9);
  });

  it('gives tied values the mean of their ranks', () => {
    // ranks: human [1.5, 1.5, 3.5, 3.5], judge [1.5, 3.5, 1.5, 3.5]: no correlation.
    expect(spearman(pairs([1, 1, 2, 2], [1, 2, 1, 2]))).toBeCloseTo(0);
    // ranks: human [1.5, 1.5, 3, 4], judge [1, 2, 3, 4]
    expect(spearman(pairs([1, 1, 2, 3], [1, 2, 3, 4]))).toBeCloseTo(0.9487, 3);
  });

  it('is null when one side never changes, since the correlation is undefined', () => {
    expect(spearman(pairs([3, 3, 3], [1, 2, 3]))).toBeNull();
    expect(spearman(pairs([1, 2, 3], [4, 4, 4]))).toBeNull();
  });

  it('is null for fewer than two pairs', () => {
    expect(spearman(pairs([3], [3]))).toBeNull();
    expect(spearman([])).toBeNull();
  });
});

describe('meanAbsoluteDifference', () => {
  it('is the mean distance between grade and score', () => {
    expect(meanAbsoluteDifference(pairs([4, 3, 5], [3.5, 3, 3]))).toBeCloseTo((0.5 + 0 + 2) / 3);
  });

  it('is null without pairs', () => {
    expect(meanAbsoluteDifference([])).toBeNull();
  });
});

interface Row {
  id: string;
  week: string | null;
  writer: string | null;
  humanGrade: number | null;
  judgeScore: number | null;
}

const row = (
  id: string,
  week: string,
  writer: string,
  humanGrade: number | null,
  judgeScore: number | null,
): Row => ({ id, week, writer, humanGrade, judgeScore });

function sheetOf(
  digests: Row[],
  picks: GradingSheet['picks'] = [],
  judge: string | null = null,
): GradingSheet {
  return GradingSheetSchema.parse({ judge, digests, picks });
}

/** Five weeks, two writers each: the human prefers `a`, and so does the judge, except in W05. */
function fullSheet(): GradingSheet {
  const digests = [
    row('d01', '2026-W01', 'a', 5, 4.75),
    row('d02', '2026-W01', 'b', 3, 3.5),
    row('d03', '2026-W02', 'a', 4, 4),
    row('d04', '2026-W02', 'b', 2, 2.25),
    row('d05', '2026-W03', 'a', 4, 4.25),
    row('d06', '2026-W03', 'b', 3, 3),
    row('d07', '2026-W04', 'a', 5, 4.5),
    row('d08', '2026-W04', 'b', 4, 3.25),
    row('d09', '2026-W05', 'a', 4, 2.5),
    row('d10', '2026-W05', 'b', 2, 3.75),
  ];
  const picks = ['W01', 'W02', 'W03', 'W04', 'W05'].map((w) => ({
    week: `2026-${w}`,
    better: 'a',
  }));
  return sheetOf(digests, picks, 'clef:latest');
}

/** The sheets built by hand in these tests have a few rows, not the spec's 10. */
const FEW = { minDigests: 1 };

describe('calibrate', () => {
  it('reports how often the judge is within half a point of the hand grade', () => {
    // differences: .25 .5 0 .25 .25 0 .5 .75 1.5 1.75 -> 7 of 10 within 0.5
    expect(calibrate(fullSheet()).judgeAgreement).toBe(0.7);
  });

  it('reports how often the judge picked the draft the maintainer picked', () => {
    // The judge prefers b in W05 only: 4 of 5 weeks.
    expect(calibrate(fullSheet()).selectionAgreement).toBe(0.8);
  });

  it('reports the rank correlation and the mean absolute difference', () => {
    const result = calibrate(fullSheet());

    expect(result.meanAbsoluteDifference).toBeCloseTo(
      (0.25 + 0.5 + 0 + 0.25 + 0.25 + 0 + 0.5 + 0.75 + 1.5 + 1.75) / 10,
    );
    expect(result.spearman).toBeGreaterThan(0.5);
    expect(result.spearman).toBeLessThan(1);
  });

  it('counts the graded digests and names the judge', () => {
    const result = calibrate(fullSheet());

    expect(result.gradedDigests).toBe(10);
    expect(result.judge).toBe('clef:latest');
  });

  it('leaves the judge out when the sheet does not name one', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 4, 4), row('d02', '2026-W01', 'b', 2, 2)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(calibrate(sheet, FEW).judge).toBeUndefined();
  });

  it('writes what the harness reads back: JudgeCalibration parses it', () => {
    expect(JudgeCalibrationSchema.safeParse(calibrate(fullSheet())).success).toBe(true);
  });

  it('is perfect when the judge scores exactly as the maintainer graded', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 5, 5), row('d02', '2026-W01', 'b', 2, 2)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(calibrate(sheet, FEW)).toMatchObject({
      judgeAgreement: 1,
      selectionAgreement: 1,
      spearman: 1,
      meanAbsoluteDifference: 0,
    });
  });

  it('takes a tie between the two scores as no pick by the judge, so it does not agree', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 5, 4), row('d02', '2026-W01', 'b', 2, 4)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(calibrate(sheet, FEW).selectionAgreement).toBe(0);
  });

  it('judges a week from the highest score of its digests', () => {
    const sheet = sheetOf(
      [
        row('d01', '2026-W01', 'a', 3, 3),
        row('d02', '2026-W01', 'b', 4, 4),
        row('d03', '2026-W01', 'c', 5, 4.5),
      ],
      [{ week: '2026-W01', better: 'c' }],
    );

    expect(calibrate(sheet, FEW).selectionAgreement).toBe(1);
  });

  it('leaves out of the selection a week the maintainer made no pick for', () => {
    const sheet = sheetOf(
      [
        row('d01', '2026-W01', 'a', 5, 5),
        row('d02', '2026-W01', 'b', 2, 2),
        row('d03', '2026-W02', 'a', 4, 4),
      ],
      [{ week: '2026-W01', better: 'a' }],
    );

    const result = calibrate(sheet, FEW);

    expect(result.selectionAgreement).toBe(1);
    expect(result.gradedDigests).toBe(3);
  });

  it('has a null rank correlation when the maintainer gave every digest the same grade', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 3, 4), row('d02', '2026-W01', 'b', 3, 2)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(calibrate(sheet, FEW).spearman).toBeNull();
  });

  it('lists every digest that is still missing a grade or a score', () => {
    const sheet = sheetOf(
      [
        row('d01', '2026-W01', 'a', null, 4),
        row('d02', '2026-W01', 'b', 3, null),
        row('d03', '2026-W02', 'a', null, null),
        row('d04', '2026-W02', 'b', 3, 3),
      ],
      [{ week: '2026-W01', better: 'a' }],
    );

    const failure = () => calibrate(sheet, FEW);

    expect(failure).toThrow(DigestError);
    expect(failure).toThrow('d01 (humanGrade), d02 (judgeScore), d03 (humanGrade, judgeScore)');
  });

  it('needs at least one pick, since the selection agreement is about the picks', () => {
    const sheet = sheetOf([row('d01', '2026-W01', 'a', 4, 4), row('d02', '2026-W01', 'b', 3, 3)]);

    expect(() => calibrate(sheet, FEW)).toThrow(/at least one pick/);
  });

  it('rejects a pick for a week with fewer than two digests', () => {
    const sheet = sheetOf([row('d01', '2026-W01', 'a', 4, 4)], [{ week: '2026-W01', better: 'a' }]);

    expect(() => calibrate(sheet, FEW)).toThrow(/2026-W01.*two different writers/);
  });

  it('rejects a pick for a week whose digests are all by one writer', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 4, 5), row('d02', '2026-W01', 'a', 3, 5)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(() => calibrate(sheet, FEW)).toThrow(/two different writers, it has 1/);
  });

  it('counts scores a hair apart as a tie, as the select step does', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 5, 4), row('d02', '2026-W01', 'b', 2, 4 + 1e-12)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(calibrate(sheet, FEW).selectionAgreement).toBe(0);
  });

  it('wants the 10 digests of the spec unless told otherwise', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 5, 5), row('d02', '2026-W01', 'b', 2, 2)],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(() => calibrate(sheet)).toThrow(DigestError);
    expect(() => calibrate(sheet)).toThrow(/10 hand-graded digests and the sheet has 2/);
    expect(calibrate(sheet, { minDigests: 2 }).gradedDigests).toBe(2);
  });

  it('rejects a pick for a writer that has no digest that week', () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 4, 4), row('d02', '2026-W01', 'b', 3, 3)],
      [{ week: '2026-W01', better: 'zed' }],
    );

    expect(() => calibrate(sheet, FEW)).toThrow(/pick for 2026-W01 names "zed".*a, b/);
  });

  it('lists a digest that has no week or no writer as incomplete too', () => {
    const sheet = sheetOf(
      [
        { ...row('d01', '2026-W01', 'a', 4, 4), week: null },
        { ...row('d02', '2026-W01', 'b', 3, 3), writer: null },
      ],
      [{ week: '2026-W01', better: 'a' }],
    );

    expect(() => calibrate(sheet, FEW)).toThrow('d01 (week), d02 (writer)');
  });

  it('does not change the sheet it was given', () => {
    const sheet = fullSheet();
    const before = structuredClone(sheet);

    calibrate(sheet, FEW);

    expect(sheet).toEqual(before);
  });
});

describe('runCalibration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'calibrate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeSheet = async (value: unknown): Promise<string> => {
    const path = join(dir, 'grades.json');
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  it('reads the sheet, writes calibration.json and says what it found', async () => {
    const sheetPath = await writeSheet(fullSheet());
    const outPath = join(dir, 'out', 'calibration.json');
    const lines: string[] = [];

    const result = await runCalibration({ sheetPath, outPath, log: (line) => lines.push(line) });

    const written: unknown = JSON.parse(await readFile(outPath, 'utf8'));
    expect(JudgeCalibrationSchema.parse(written)).toEqual(result);
    expect(result.judgeAgreement).toBe(0.7);
    expect((await readFile(outPath, 'utf8')).endsWith('\n')).toBe(true);
    expect(lines.join('\n')).toContain('Judge agreement: 70%');
    expect(lines.join('\n')).toContain('Selection agreement: 80%');
    expect(lines.join('\n')).toContain('Spearman');
    expect(lines.join('\n')).toContain('Mean absolute difference: ');
    expect(lines.join('\n')).toContain(outPath);
  });

  it('says so when the judge is under the 80% bar and its scores will not be gated', async () => {
    const sheetPath = await writeSheet(fullSheet());
    const lines: string[] = [];

    await runCalibration({ sheetPath, outPath: join(dir, 'c.json'), log: (l) => lines.push(l) });

    expect(lines.join('\n')).toContain('under 80%: the judge scores are reported, not gated');
  });

  it('says the judge scores are gated when it agrees at least 80% of the time', async () => {
    const sheet = sheetOf(
      [row('d01', '2026-W01', 'a', 5, 5), row('d02', '2026-W01', 'b', 2, 2)],
      [{ week: '2026-W01', better: 'a' }],
    );
    const lines: string[] = [];

    await runCalibration({
      sheetPath: await writeSheet(sheet),
      outPath: join(dir, 'c.json'),
      log: (l) => lines.push(l),
      minDigests: 1,
    });

    expect(lines.join('\n')).toContain('at least 80%: the judge scores are gated');
  });

  it('does not write anything when the sheet is incomplete', async () => {
    const sheetPath = await writeSheet(
      sheetOf([row('d01', '2026-W01', 'a', null, 4)], [{ week: '2026-W01', better: 'a' }]),
    );
    const outPath = join(dir, 'calibration.json');

    await expect(runCalibration({ sheetPath, outPath, minDigests: 1 })).rejects.toThrow(
      /still missing/,
    );
    await expect(readFile(outPath, 'utf8')).rejects.toThrow();
  });

  it('names the file when it is not valid JSON', async () => {
    const sheetPath = join(dir, 'grades.json');
    await writeFile(sheetPath, '{ nope');

    await expect(runCalibration({ sheetPath, outPath: join(dir, 'c.json') })).rejects.toThrow(
      /grades\.json is not valid JSON/,
    );
  });

  it('names the file when it does not match the sheet schema', async () => {
    const sheetPath = await writeSheet({ digests: [] });

    const failure = runCalibration({ sheetPath, outPath: join(dir, 'c.json') });

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow(/grades\.json does not match the grading sheet/);
  });

  it('names the file when it does not exist', async () => {
    const sheetPath = join(dir, 'missing.json');

    await expect(runCalibration({ sheetPath, outPath: join(dir, 'c.json') })).rejects.toThrow(
      /Cannot read .*missing\.json/,
    );
  });

  it('prints to the console when no log is given', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sheetPath = await writeSheet(fullSheet());

    await runCalibration({ sheetPath, outPath: join(dir, 'c.json') });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Judge agreement: 70%'));
  });

  it('creates the folder of the output file', async () => {
    const sheetPath = await writeSheet(fullSheet());
    await mkdir(join(dir, 'deep'), { recursive: true });
    const outPath = join(dir, 'deep', 'er', 'calibration.json');

    await runCalibration({ sheetPath, outPath });

    expect(JSON.parse(await readFile(outPath, 'utf8'))).toMatchObject({ gradedDigests: 10 });
  });
});

describe('main', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'calibrate-main-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('calibrates the sheet it is given and returns 0', async () => {
    const sheetPath = join(dir, 'grades.json');
    const outPath = join(dir, 'calibration.json');
    await writeFile(sheetPath, JSON.stringify(fullSheet()));
    const lines: string[] = [];

    const code = await main([sheetPath, outPath], (line) => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Judge agreement: 70%');
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toMatchObject({ judgeAgreement: 0.7 });
  });

  it('reports a failure on stderr by default', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const code = await main([join(dir, 'missing.json')]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('calibrate failed:'));
  });

  it('accepts a smaller sheet when told to with --min-digests', async () => {
    const sheetPath = join(dir, 'grades.json');
    const outPath = join(dir, 'calibration.json');
    await writeFile(
      sheetPath,
      JSON.stringify(
        sheetOf(
          [row('d01', '2026-W01', 'a', 5, 5), row('d02', '2026-W01', 'b', 2, 2)],
          [{ week: '2026-W01', better: 'a' }],
        ),
      ),
    );
    const failures: string[] = [];

    const refused = await main([sheetPath, outPath], undefined, (line) => failures.push(line));
    const accepted = await main([sheetPath, outPath, '--min-digests', '2'], () => undefined);

    expect(refused).toBe(1);
    expect(failures[0]).toContain('10 hand-graded digests and the sheet has 2');
    expect(accepted).toBe(0);
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toMatchObject({ gradedDigests: 2 });
  });

  it('rejects a --min-digests that is not a whole number of 1 or more', async () => {
    const failures: string[] = [];

    for (const bad of ['0', '2.5', 'many']) {
      const code = await main(['--min-digests', bad], undefined, (line) => failures.push(line));
      expect(code).toBe(1);
    }

    expect(failures).toHaveLength(3);
    expect(failures[0]).toContain('--min-digests needs a whole number of 1 or more, not "0"');
  });

  it('rejects an option it does not know', async () => {
    const failures: string[] = [];

    const code = await main(['--nope'], undefined, (line) => failures.push(line));

    expect(code).toBe(1);
    expect(failures[0]).toContain('calibrate failed:');
  });

  it('prints what went wrong and returns 1 when the sheet cannot be used', async () => {
    const failures: string[] = [];

    const code = await main(
      [join(dir, 'missing.json'), join(dir, 'out.json')],
      () => undefined,
      (line) => failures.push(line),
    );

    expect(code).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^calibrate failed: Cannot read .*missing\.json/);
  });
});
