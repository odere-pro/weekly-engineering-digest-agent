// The grading sheet the maintainer fills in for the judge calibration (W3-04 prep).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRADED_DIGESTS, GradingSheetSchema, createGradingSheetTemplate } from './gradingSheet';

const TEMPLATE_PATH = join(import.meta.dirname, 'grades.template.json');

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  week: '2026-W36',
  writer: 'gemma4:31b-mlx',
  humanGrade: 4,
  judgeScore: 3.75,
  ...overrides,
});

describe('GradingSheetSchema', () => {
  it('parses a filled sheet', () => {
    const sheet = GradingSheetSchema.parse({
      judge: 'clef:latest',
      digests: [row('d01'), row('d02', { writer: 'nemotron', notes: 'wordy' })],
      picks: [{ week: '2026-W36', better: 'gemma4:31b-mlx' }],
    });

    expect(sheet.digests).toHaveLength(2);
    expect(sheet.digests[1]?.notes).toBe('wordy');
    expect(sheet.digests[0]?.notes).toBe('');
  });

  it('parses a template row that is still blank', () => {
    const sheet = GradingSheetSchema.parse({
      judge: null,
      digests: [{ id: 'd01', week: null, writer: null, humanGrade: null, judgeScore: null }],
      picks: [],
    });

    expect(sheet.digests[0]?.humanGrade).toBeNull();
  });

  it('rejects a grade outside 1 to 5', () => {
    for (const bad of [0, 0.9, 5.1, 6]) {
      const result = GradingSheetSchema.safeParse({
        judge: null,
        digests: [row('d01', { humanGrade: bad })],
        picks: [],
      });
      expect(result.success, String(bad)).toBe(false);
    }
  });

  it('rejects a judge score outside 1 to 5', () => {
    const result = GradingSheetSchema.safeParse({
      judge: null,
      digests: [row('d01', { judgeScore: 7 })],
      picks: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a half-point grade', () => {
    const result = GradingSheetSchema.safeParse({
      judge: null,
      digests: [row('d01', { humanGrade: 3.5 })],
      picks: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects two digests with the same id', () => {
    const result = GradingSheetSchema.safeParse({
      judge: null,
      digests: [row('d01'), row('d01')],
      picks: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects two picks for the same week', () => {
    const result = GradingSheetSchema.safeParse({
      judge: null,
      digests: [row('d01')],
      picks: [
        { week: '2026-W36', better: 'a' },
        { week: '2026-W36', better: 'b' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a sheet with no digests', () => {
    expect(GradingSheetSchema.safeParse({ judge: null, digests: [], picks: [] }).success).toBe(
      false,
    );
  });

  it('rejects a week that is not an ISO week id', () => {
    const result = GradingSheetSchema.safeParse({
      judge: null,
      digests: [row('d01', { week: 'W36' })],
      picks: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('createGradingSheetTemplate', () => {
  it('has a blank row for each of the 10 digests to grade', () => {
    const sheet = createGradingSheetTemplate();

    expect(GRADED_DIGESTS).toBe(10);
    expect(sheet.digests.map((digest) => digest.id)).toEqual([
      'd01',
      'd02',
      'd03',
      'd04',
      'd05',
      'd06',
      'd07',
      'd08',
      'd09',
      'd10',
    ]);
    for (const digest of sheet.digests) {
      expect(digest).toMatchObject({
        week: null,
        writer: null,
        draft: null,
        humanGrade: null,
        judgeScore: null,
        notes: '',
      });
    }
    expect(sheet.judge).toBeNull();
    expect(sheet.picks).toEqual([]);
  });

  it('parses with the schema it belongs to', () => {
    expect(GradingSheetSchema.safeParse(createGradingSheetTemplate()).success).toBe(true);
  });

  it('tells the maintainer what to fill in', () => {
    const { instructions } = createGradingSheetTemplate();

    expect(instructions).toContain('humanGrade');
    expect(instructions).toContain('picks');
    expect(instructions).toContain('judgeScore');
  });

  it('names the command that adds a run and the one that reveals the scores', () => {
    const { instructions } = createGradingSheetTemplate();

    expect(instructions).toContain('evals/judge/runDrafts/addRun.ts dist/');
    expect(instructions).toContain('--reveal');
  });

  it('can make a sheet of another size', () => {
    expect(createGradingSheetTemplate(3).digests.map((digest) => digest.id)).toEqual([
      'd01',
      'd02',
      'd03',
    ]);
  });

  it('makes a new sheet each time', () => {
    const first = createGradingSheetTemplate();
    const second = createGradingSheetTemplate();
    expect(first).toEqual(second);
    expect(first.digests).not.toBe(second.digests);
  });

  it('is what evals/judge/grades.template.json holds', async () => {
    const committed: unknown = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    expect(committed).toEqual(createGradingSheetTemplate());
  });
});
