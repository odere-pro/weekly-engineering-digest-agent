import { describe, expect, it } from 'vitest';
import { makeDraft, makeItem, makeRunRecord } from '../../../test/builders';
import { renderDigest } from '../../../src/render/markdown';
import type { RunRecord } from '../../../src/store/runRecord';
import { createGradingSheetTemplate, GradingSheetSchema } from '../gradingSheet';
import {
  addToSheet,
  draftsToGrade,
  judgeOf,
  judgeScoresOf,
  JudgeScoresSchema,
  revealScores,
  writerSlug,
} from './runPair';

const JUDGE = 'clef:latest';
const GEMMA = 'gemma4:31b-mlx';
const NEMOTRON = 'nemotron-3.5-lightning:30b-mlx';

const score = (writer: string, value: number) => ({
  writer,
  score: value,
  byCriterion: { accuracy: value },
});

function qualityRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return makeRunRecord({
    runId: '2026-W43',
    modelsByRole: { write: [GEMMA, NEMOTRON], judge: JUDGE },
    drafts: [
      { writer: GEMMA, passed: true, rejectedBy: [], score: score(GEMMA, 3.6) },
      { writer: NEMOTRON, passed: true, rejectedBy: [], score: score(NEMOTRON, 3.2) },
    ],
    winner: GEMMA,
    ...overrides,
  });
}

const drafts = [makeDraft([makeItem()], GEMMA), makeDraft([makeItem()], NEMOTRON)];

describe('writerSlug', () => {
  it('turns a model tag into a file name', () => {
    expect(writerSlug(GEMMA)).toBe('gemma4-31b-mlx');
    expect(writerSlug(NEMOTRON)).toBe('nemotron-3-5-lightning-30b-mlx');
  });

  it('never yields a path: slashes and dots become dashes', () => {
    expect(writerSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(writerSlug('a/b\\c')).toBe('a-b-c');
  });

  it('refuses a tag with no letter or digit', () => {
    expect(() => writerSlug('../')).toThrow(/writer/);
  });
});

describe('judgeOf', () => {
  it("reads the run's judge tag", () => {
    expect(judgeOf(qualityRun())).toBe(JUDGE);
  });

  it('refuses a run without one judge', () => {
    expect(() => judgeOf(qualityRun({ modelsByRole: { judge: null } }))).toThrow(/judge/);
    expect(() => judgeOf(qualityRun({ modelsByRole: {} }))).toThrow(/judge/);
  });
});

describe('draftsToGrade', () => {
  it('gives one row per scored draft, with its saved path and the judge score', () => {
    const rows = draftsToGrade(qualityRun(), drafts);

    expect(
      rows.map(({ week, writer, draft, file, judgeScore }) => [
        week,
        writer,
        draft,
        file,
        judgeScore,
      ]),
    ).toEqual([
      [
        '2026-W43',
        GEMMA,
        'evals/judge/2026-W43/gemma4-31b-mlx.md',
        '2026-W43/gemma4-31b-mlx.md',
        3.6,
      ],
      [
        '2026-W43',
        NEMOTRON,
        'evals/judge/2026-W43/nemotron-3-5-lightning-30b-mlx.md',
        '2026-W43/nemotron-3-5-lightning-30b-mlx.md',
        3.2,
      ],
    ]);
  });

  it('renders each draft as the run would print it', () => {
    const record = qualityRun({ disabledGuards: ['graniteRisk'] });

    const [first] = draftsToGrade(record, drafts);

    expect(first?.markdown).toBe(
      renderDigest(drafts[0]!.digest, { disabledGuards: ['graniteRisk'] }),
    );
  });

  it('skips a draft the judge did not score', () => {
    const record = qualityRun({
      drafts: [
        { writer: GEMMA, passed: true, rejectedBy: [], score: score(GEMMA, 4) },
        { writer: NEMOTRON, passed: false, rejectedBy: ['linkCheck'] },
      ],
    });

    expect(draftsToGrade(record, drafts).map((row) => row.writer)).toEqual([GEMMA]);
  });

  it('refuses a run with no scored draft', () => {
    expect(() => draftsToGrade(qualityRun({ drafts: [] }), drafts)).toThrow(
      /no draft the judge scored/,
    );
  });

  it('refuses two writers whose tags give the same file name', () => {
    const twin = 'Gemma4-31b:mlx';
    const record = qualityRun({
      drafts: [
        { writer: GEMMA, passed: true, rejectedBy: [], score: score(GEMMA, 4) },
        { writer: twin, passed: true, rejectedBy: [], score: score(twin, 3) },
      ],
    });

    expect(() => draftsToGrade(record, [drafts[0]!, makeDraft([makeItem()], twin)])).toThrow(
      /same file/,
    );
  });

  it('refuses a scored writer missing from drafts.json', () => {
    expect(() => draftsToGrade(qualityRun(), [drafts[0]!])).toThrow(/drafts\.json has no draft by/);
  });
});

describe('judgeScoresOf', () => {
  it('keeps the judge, the run and each writer score for judge.json', () => {
    const record = qualityRun();

    const saved = judgeScoresOf(record, JUDGE, draftsToGrade(record, drafts));

    expect(JudgeScoresSchema.parse(saved)).toEqual({
      week: '2026-W43',
      judge: JUDGE,
      runStartedAt: record.startedAt,
      scores: [
        { writer: GEMMA, judgeScore: 3.6 },
        { writer: NEMOTRON, judgeScore: 3.2 },
      ],
    });
  });
});

describe('addToSheet', () => {
  const rows = draftsToGrade(qualityRun(), drafts);

  it('fills the first blank rows, leaves the judge score out and names the judge', () => {
    const sheet = addToSheet(createGradingSheetTemplate(), JUDGE, rows);

    expect(sheet.judge).toBe(JUDGE);
    expect(
      sheet.digests.slice(0, 3).map((d) => [d.id, d.week, d.writer, d.draft, d.judgeScore]),
    ).toEqual([
      ['d01', '2026-W43', GEMMA, 'evals/judge/2026-W43/gemma4-31b-mlx.md', null],
      ['d02', '2026-W43', NEMOTRON, 'evals/judge/2026-W43/nemotron-3-5-lightning-30b-mlx.md', null],
      ['d03', null, null, null, null],
    ]);
    expect(GradingSheetSchema.parse(sheet)).toEqual(sheet);
  });

  it('keeps a row for the same week and writer as it is', () => {
    const first = addToSheet(createGradingSheetTemplate(), JUDGE, rows);
    const graded = {
      ...first,
      digests: first.digests.map((d) =>
        d.id === 'd01' ? { ...d, humanGrade: 4, notes: 'clear' } : d,
      ),
    };

    const again = addToSheet(graded, JUDGE, rows);

    expect(again).toEqual(graded);
  });

  it('adds a row with a new id when no blank row is left', () => {
    const sheet = addToSheet(createGradingSheetTemplate(1), JUDGE, rows);

    expect(sheet.digests.map((d) => d.id)).toEqual(['d01', 'd02']);
    expect(GradingSheetSchema.parse(sheet).digests).toHaveLength(2);
  });

  it('refuses scores from another judge', () => {
    const sheet = { ...createGradingSheetTemplate(), judge: 'other:judge' };

    expect(() => addToSheet(sheet, JUDGE, rows)).toThrow(/other:judge/);
  });

  it('does not change the sheet it was given', () => {
    const sheet = createGradingSheetTemplate();
    const before = structuredClone(sheet);

    addToSheet(sheet, JUDGE, rows);

    expect(sheet).toEqual(before);
  });
});

describe('revealScores', () => {
  const record = qualityRun();
  const rows = draftsToGrade(record, drafts);
  const saved = [judgeScoresOf(record, JUDGE, rows)];
  const added = addToSheet(createGradingSheetTemplate(), JUDGE, rows);
  const graded = (ids: readonly string[]) => ({
    ...added,
    digests: added.digests.map((d) => (ids.includes(d.id) ? { ...d, humanGrade: 4 } : d)),
  });

  it("holds back a week's scores until every draft of that week has a grade", () => {
    const { sheet, revealed, waiting } = revealScores(graded(['d01']), saved);

    expect(sheet.digests.slice(0, 2).map((d) => d.judgeScore)).toEqual([null, null]);
    expect(revealed).toBe(0);
    expect(waiting).toEqual(['d02']);
  });

  it('fills every score of a fully graded week', () => {
    const { sheet, revealed, waiting } = revealScores(graded(['d01', 'd02']), saved);

    expect(sheet.digests.slice(0, 2).map((d) => d.judgeScore)).toEqual([3.6, 3.2]);
    expect(revealed).toBe(2);
    expect(waiting).toEqual([]);
  });

  it('leaves blank rows and revealed scores alone', () => {
    const once = revealScores(graded(['d01', 'd02']), saved).sheet;

    const twice = revealScores(once, saved);

    expect(twice.sheet).toEqual(once);
    expect(twice.revealed).toBe(0);
  });

  it('refuses a graded week with no saved score', () => {
    expect(() => revealScores(graded(['d01', 'd02']), [])).toThrow(
      /No saved judge score for gemma4:31b-mlx in 2026-W43/,
    );
  });

  it('refuses saved scores from another judge', () => {
    const other = saved.map((file) => ({ ...file, judge: 'other:judge' }));

    expect(() => revealScores(graded(['d01', 'd02']), other)).toThrow(/other:judge/);
  });

  it('does not change the sheet it was given', () => {
    const sheet = graded(['d01', 'd02']);
    const before = structuredClone(sheet);

    revealScores(sheet, saved);

    expect(sheet).toEqual(before);
  });
});
