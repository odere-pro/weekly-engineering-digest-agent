import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fitCalibration,
  keepCalibration,
  measureSide,
  runCli,
  trainSamples,
  type Sample,
} from './calibrate';
import { CalibrationSchema, calibrateClassification } from '../src/process/calibration';
import { makeClassification, makeItem } from '../test/builders';
import type { RawCapture } from './thresholds/capture';
import type { EvalCases } from './runEval';

const sample = (raw: number, target: number, area = 'a'): Sample => ({ raw, target, area });

describe('fitCalibration', () => {
  it('is monotone even when the data runs the wrong way', () => {
    const fit = fitCalibration(
      [sample(1, 3), sample(1.5, 2), sample(2, 1), sample(2.5, 0.5)],
      'light',
    );
    const ys = fit.points.map((p) => p.calibrated);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(fit.points.map((p) => p.raw)).toEqual([...fit.points.map((p) => p.raw)].sort());
  });

  it('pools violators to their mean and keeps rising data as it is', () => {
    const fit = fitCalibration([sample(1, 0), sample(2, 1), sample(3, 3)], 'light');
    expect(fit.points).toEqual([
      { raw: 1, calibrated: 0 },
      { raw: 2, calibrated: 1 },
      { raw: 3, calibrated: 3 },
    ]);
    const pooled = fitCalibration([sample(1, 2), sample(2, 0)], 'light');
    expect(pooled.points).toEqual([{ raw: 1.5, calibrated: 1 }]);
  });

  it('groups equal raw scores', () => {
    const fit = fitCalibration([sample(1, 0), sample(1, 2), sample(2, 3)], 'light');
    expect(fit.points).toEqual([
      { raw: 1, calibrated: 1 },
      { raw: 2, calibrated: 3 },
    ]);
  });

  it('shrinks the area bias toward zero and ignores areas without data', () => {
    const many = Array.from({ length: 20 }, () => sample(2, 3, 'Big'));
    const one = [sample(2, 3, 'Small')];
    const fit = fitCalibration([...many, ...one, sample(1, 0, 'other')], 'light');
    expect(Math.abs(fit.areaBias['small'] ?? 0)).toBeLessThan(
      Math.abs(fit.areaBias['big'] ?? 1) + 1,
    );
    expect(Object.keys(fit.areaBias)).toContain('big');
  });

  it('refuses to fit nothing', () => {
    expect(() => fitCalibration([], 'light')).toThrow(/no samples/i);
  });
});

function raw(): RawCapture {
  const ok = (relevance: number, area = 'a') => ({
    relevance,
    area,
    areaConfidence: 0.9,
    hype: 0.1,
    minorRelease: 0.1,
  });
  const week = (
    weekId: string,
    itemId: string,
    label: 'mustInclude' | 'mustExclude' | null,
    r: number,
  ) => ({
    itemId,
    weekId,
    label,
    result: ok(r),
  });
  return {
    profile: 'light',
    capturedAt: '2026-10-17T10:00:00.000Z',
    ollamaVersion: null,
    models: { classify: 'm', guardPolicy: 'm', guardRisk: 'm' },
    focusAreas: ['a'],
    baseline: { minRelevance: 1, maxHype: 1, maxMinorRelease: 1, guardFlag: 0.5 },
    classifier: [0, 1, 2, 3, 4, 5].map((i) => ({
      itemId: `c${i}`,
      expected: { area: 'a', relevance: i % 4 },
      result: i === 4 ? { error: 'boom' } : ok(1 + (i % 4) / 2),
    })),
    weekItems: [
      week('2026-W40', 'x1', 'mustInclude', 1),
      week('2026-W40', 'x2', 'mustExclude', 2),
      week('2026-W36', 'y1', 'mustInclude', 2),
      week('2026-W36', 'y2', 'mustExclude', 1),
      week('2026-W36', 'y3', null, 1.5),
    ],
    inputGuards: [],
    outputGuards: [],
    timingsMs: {},
  } as unknown as RawCapture;
}

describe('trainSamples', () => {
  it('uses only train records, skips failed calls and unlabeled week items', () => {
    const samples = trainSamples(raw(), { holdoutWeeks: ['2026-W40'], caseStride: 3 });
    // cases: c2 and c5 are held out; c4 failed; so c0, c1, c3 remain. Week W36: 2 labeled items.
    expect(samples).toHaveLength(3 + 2);
    expect(samples.filter((s) => s.target === 3 || s.target === 0)).toHaveLength(4);
  });
});

describe('measureSide', () => {
  const items = ['x1', 'x2'].map((id) => makeItem({ id, title: `Thing ${id}` }));
  const cases = {
    weeks: [{ weekId: '2026-W40', items, labels: { mustInclude: ['x1'], mustExclude: ['x2'] } }],
    classifier: { reviewed: true, cases: [] },
  } as unknown as EvalCases;
  const thresholds = { minRelevance: 0, maxHype: 1, maxMinorRelease: 1, guardFlag: 0.5 };
  const holdoutRaw = (): RawCapture => {
    const r = raw();
    return { ...r, classifier: [], weekItems: r.weekItems.filter((w) => w.weekId === '2026-W40') };
  };

  it('counts recall and leaks in the top 5 and within-one accuracy', () => {
    const base = measureSide(holdoutRaw(), cases, thresholds, null, 1);
    expect(base.recall).toBe(0);
    expect(base.leaks).toBe(1);
    const flipped = fitCalibration([sample(1, 3), sample(2, 0)], 'light');
    const topOne = measureSide(holdoutRaw(), cases, thresholds, flipped, 1);
    expect(topOne.recall).toBe(1);
    expect(topOne.leaks).toBe(0);
  });

  it('reports within-one accuracy of calibrated relevance on holdout cases', () => {
    const r = holdoutRaw();
    const withCases: RawCapture = {
      ...r,
      classifier: [
        {
          itemId: 'k',
          expected: { area: 'a', relevance: 3 },
          result: { relevance: 1, area: 'a', areaConfidence: 1, hype: 0, minorRelease: 0 },
        },
      ],
    };
    expect(measureSide(withCases, cases, thresholds, null, 1).withinOne).toBe(0);
    const lift = {
      version: 1 as const,
      profile: 'light' as const,
      points: [{ raw: 1, calibrated: 2.5 }],
      areaBias: {},
    };
    expect(calibrateClassification(lift, makeClassification('k', { relevance: 1 })).relevance).toBe(
      2.5,
    );
    expect(measureSide(withCases, cases, thresholds, lift, 1).withinOne).toBe(1);
  });
});

describe('keepCalibration', () => {
  const m = (recall: number, leaks: number) => ({ recall, leaks, withinOne: 0.5 });
  it('keeps only when recall rises and leaks do not', () => {
    expect(keepCalibration(m(1, 1), m(1.5, 1))).toBe(true);
    expect(keepCalibration(m(1, 1), m(1.5, 2))).toBe(false);
    expect(keepCalibration(m(1, 1), m(1, 1))).toBe(false);
    expect(keepCalibration(m(1, 1), m(0.5, 0))).toBe(false);
  });
});

describe('runCli', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function kit(args: string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'calibrate-'));
    dirs.push(dir);
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify(raw()));
    const out: string[] = [];
    const err: string[] = [];
    const items = ['x1', 'x2'].map((id) => makeItem({ id }));
    const cases = {
      weeks: [{ weekId: '2026-W40', items, labels: { mustInclude: ['x1'], mustExclude: ['x2'] } }],
      classifier: { reviewed: true, cases: [] },
    } as unknown as EvalCases;
    const code = await runCli([rawPath, ...args.map((a) => a.replace('$DIR', dir))], {
      casesDir: dir,
      loadCases: () => Promise.resolve(cases),
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    return { dir, code, out: out.join(''), err: err.join('') };
  }

  it('prints usage without arguments', async () => {
    const err: string[] = [];
    const code = await runCli([], { stderr: (t) => err.push(t) });
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/Usage/);
  });

  it('exits 2 on an unknown option', async () => {
    const err: string[] = [];
    expect(await runCli(['--bogus'], { stderr: (t) => err.push(t) })).toBe(2);
  });

  it('prints the holdout table and writes the file only when it is kept', async () => {
    const { dir, code, out } = await kit([
      '--holdout',
      '2026-W40',
      '--write',
      '--out',
      '$DIR/c.json',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('holdout recall');
    const kept = out.includes('verdict: keep');
    const exists = await access(join(dir, 'c.json')).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(kept);
    if (kept)
      expect(
        CalibrationSchema.safeParse(JSON.parse(await readFile(join(dir, 'c.json'), 'utf8')))
          .success,
      ).toBe(true);
  });

  it('does not write without --write', async () => {
    const { dir, code } = await kit([]);
    expect(code).toBe(0);
    await expect(access(join(dir, 'calibration', 'light.json'))).rejects.toThrow();
  });

  it('exits 1 for a bad capture or a bad holdout week', async () => {
    expect((await kit(['--holdout', 'nope'])).code).toBe(1);
    const err: string[] = [];
    expect(await runCli(['/no/such/file.json'], { stderr: (t) => err.push(t) })).toBe(1);
    expect(err.join('')).toContain('calibrate failed');
  });
});
