import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDraft, makeItem, makeRunRecord } from '../../../test/builders';
import { GradingSheetSchema, type GradingSheet } from '../gradingSheet';
import { addRun, main, reveal } from './addRun';
import { JudgeScoresSchema } from './runPair';

const JUDGE = 'clef:latest';
const WRITER = 'gemma4:31b-mlx';
const DRAFT_FILE = join('2026-W43', 'gemma4-31b-mlx.md');
const SCORES_FILE = join('scores', '2026-W43.json');

let root: string;
let runDir: string;
let judgeDir: string;
let sheetPath: string;

async function saveRun(judge: string | null = JUDGE, startedAt = '2026-10-19T21:05:54.753Z') {
  const record = makeRunRecord({
    runId: '2026-W43',
    startedAt,
    modelsByRole: { judge },
    drafts: [
      {
        writer: WRITER,
        passed: true,
        rejectedBy: [],
        score: { writer: WRITER, score: 3.5, byCriterion: {} },
      },
    ],
  });
  await writeFile(join(runDir, 'run.json'), JSON.stringify(record));
  await writeFile(
    join(runDir, 'drafts.json'),
    JSON.stringify({ drafts: [makeDraft([makeItem()], WRITER, { weekId: '2026-W43' })] }),
  );
}

const readSheet = async (): Promise<GradingSheet> =>
  GradingSheetSchema.parse(JSON.parse(await readFile(sheetPath, 'utf8')));

async function grade(id: string, humanGrade: number): Promise<void> {
  const sheet = await readSheet();
  const digests = sheet.digests.map((d) => (d.id === id ? { ...d, humanGrade } : d));
  await writeFile(sheetPath, JSON.stringify({ ...sheet, digests }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'judge-add-run-'));
  runDir = join(root, 'run');
  judgeDir = join(root, 'judge');
  sheetPath = join(judgeDir, 'grades.json');
  await mkdir(runDir);
});

describe('addRun', () => {
  it('saves the draft, keeps the scores outside its folder, and adds a row without the score', async () => {
    await saveRun();
    const lines: string[] = [];

    await addRun({ runDir, judgeDir, sheetPath, log: (line) => lines.push(line) });

    expect(await readFile(join(judgeDir, DRAFT_FILE), 'utf8')).toContain('Week 2026-W43');
    const saved = JudgeScoresSchema.parse(
      JSON.parse(await readFile(join(judgeDir, SCORES_FILE), 'utf8')),
    );
    expect(saved.scores).toEqual([{ writer: WRITER, judgeScore: 3.5 }]);
    const sheet = await readSheet();
    expect(sheet.judge).toBe(JUDGE);
    expect(sheet.digests).toHaveLength(10);
    expect(sheet.digests[0]).toMatchObject({
      week: '2026-W43',
      writer: WRITER,
      draft: 'evals/judge/2026-W43/gemma4-31b-mlx.md',
      judgeScore: null,
      humanGrade: null,
    });
    expect(lines.join('\n')).not.toContain('3.5');
  });

  it('adding the same run again leaves every saved file as it is', async () => {
    await saveRun();
    await addRun({ runDir, judgeDir, sheetPath });
    await writeFile(join(judgeDir, DRAFT_FILE), 'my notes on this draft\n');
    const sheet = await readFile(sheetPath, 'utf8');

    await addRun({ runDir, judgeDir, sheetPath });

    expect(await readFile(join(judgeDir, DRAFT_FILE), 'utf8')).toBe('my notes on this draft\n');
    expect(await readFile(sheetPath, 'utf8')).toBe(sheet);
  });

  it('refuses another run of a week already added, and writes nothing', async () => {
    await saveRun();
    await addRun({ runDir, judgeDir, sheetPath });
    const draft = await readFile(join(judgeDir, DRAFT_FILE), 'utf8');
    await saveRun(JUDGE, '2026-10-26T05:00:00.000Z');

    await expect(addRun({ runDir, judgeDir, sheetPath })).rejects.toThrow(/already added/);
    expect(await readFile(join(judgeDir, DRAFT_FILE), 'utf8')).toBe(draft);
  });

  it('refuses a grades.json that does not parse, and saves no draft', async () => {
    await saveRun();
    await mkdir(judgeDir);
    await writeFile(sheetPath, '{"digests": []}');

    await expect(addRun({ runDir, judgeDir, sheetPath })).rejects.toThrow(/grades\.json/);
    await expect(readFile(join(judgeDir, DRAFT_FILE), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('names a run file that is not JSON', async () => {
    await writeFile(join(runDir, 'run.json'), '{ not json');

    await expect(addRun({ runDir, judgeDir, sheetPath })).rejects.toThrow(/run\.json/);
  });

  it('names a saved scores file it cannot read', async () => {
    await saveRun();
    await mkdir(join(judgeDir, 'scores'), { recursive: true });
    await writeFile(join(judgeDir, SCORES_FILE), '[]');

    await expect(addRun({ runDir, judgeDir, sheetPath })).rejects.toThrow(/2026-W43\.json/);
  });

  it('writes nothing when the run has no judge', async () => {
    await saveRun(null);

    await expect(addRun({ runDir, judgeDir, sheetPath })).rejects.toThrow(/judge/);
    await expect(readFile(sheetPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('reveal', () => {
  it('fills the score once the week is graded', async () => {
    await saveRun();
    await addRun({ runDir, judgeDir, sheetPath });
    await grade('d01', 4);
    const lines: string[] = [];

    await reveal({ judgeDir, sheetPath, log: (line) => lines.push(line) });

    expect((await readSheet()).digests[0]).toMatchObject({ humanGrade: 4, judgeScore: 3.5 });
    expect(lines.join('\n')).toMatch(/1 judge score revealed, 0 rows still to grade/);
  });

  it('reveals nothing before a grade and leaves the sheet as it is', async () => {
    await saveRun();
    await addRun({ runDir, judgeDir, sheetPath });
    const before = await readFile(sheetPath, 'utf8');

    await reveal({ judgeDir, sheetPath });

    expect(await readFile(sheetPath, 'utf8')).toBe(before);
  });
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failsWith = async (args: readonly string[], reason: RegExp): Promise<void> => {
    const lines: string[] = [];
    expect(await main(args, undefined, (line) => lines.push(line))).toBe(1);
    expect(lines[0]).toMatch(reason);
  };

  it('needs exactly one run folder, and none with --reveal', async () => {
    await failsWith([], /^add-run failed: .*run folder/);
    await failsWith(['a', 'b'], /^add-run failed: .*one run folder/);
    await failsWith(['--reveal', 'a'], /^add-run failed: .*--reveal takes no run folder/);
  });

  it('adds a run, then reveals with --reveal', async () => {
    await saveRun();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    expect(await main([runDir, '--judge-dir', judgeDir], log)).toBe(0);
    await grade('d01', 3);
    expect(await main(['--reveal', '--judge-dir', judgeDir, '--sheet', sheetPath], log)).toBe(0);

    expect(lines.join('\n')).toMatch(/2026-W43 gemma4:31b-mlx: saved evals\/judge\/2026-W43/);
    expect((await readSheet()).digests[0]?.judgeScore).toBe(3.5);
  });

  it('prints to the console by default', async () => {
    await saveRun();
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await main([runDir, '--judge-dir', judgeDir])).toBe(0);
    expect(await main([join(root, 'nope')])).toBe(1);

    expect(out).toHaveBeenCalledWith(expect.stringMatching(/^2026-W43 gemma4:31b-mlx/));
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^add-run failed: /));
  });
});
