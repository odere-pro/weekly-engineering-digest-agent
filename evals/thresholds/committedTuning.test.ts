import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/shared/clock';
import { evalSet, captureDeps, scriptedModel } from './__fixtures__/captureKit';
import { RawCaptureSchema, type RawCapture } from './capture/schemas';
import { captureCommand } from './cli/captureCommand';
import type { CliIo } from './cli/io';
import { sweepCommand } from './cli/sweepCommand';
import { tuneThresholds } from './result/tune';

// Drift guard: the sweep run on the capture committed in raw/ must give the committed result,
// number for number and key for key. A change to the grid search, the split, the keep rule or
// the result layout that moves any of them fails here. A fresh capture must have the layout of
// the committed one, so old raw files stay readable and new ones read like them.

const THRESHOLDS_DIR = import.meta.dirname;

async function committedLight(): Promise<{ raw: RawCapture; name: string; result: unknown }> {
  const names = (await readdir(join(THRESHOLDS_DIR, 'raw'))).filter((n) =>
    n.endsWith('-light.json'),
  );
  const latest = names.sort().at(-1);
  if (latest === undefined) throw new Error('no light-profile raw capture in evals/thresholds/raw');
  const raw = RawCaptureSchema.parse(
    JSON.parse(await readFile(join(THRESHOLDS_DIR, 'raw', latest), 'utf8')),
  );
  const result: unknown = JSON.parse(await readFile(join(THRESHOLDS_DIR, latest), 'utf8'));
  return { raw, name: latest, result };
}

describe('the committed light-profile tuning', () => {
  it('is what the sweep makes of the committed raw outputs', async () => {
    const { raw, result } = await committedLight();
    expect(tuneThresholds(raw)).toEqual(result);
  });

  it('covers the 60 classifier cases and the 10 attack cases', async () => {
    const { raw } = await committedLight();
    expect(raw.classifier).toHaveLength(60);
    expect(raw.inputGuards.filter((g) => g.kind === 'attack')).toHaveLength(10);
  });

  it('reaches filter accuracy of 80% or more on the light profile at the proposed thresholds', async () => {
    const { raw } = await committedLight();
    expect(tuneThresholds(raw).acceptance.filterAccuracy.value).toBeGreaterThanOrEqual(0.8);
  });

  it('proposes the thresholds the README reports, picked on train', async () => {
    const { raw } = await committedLight();
    const result = tuneThresholds(raw);
    // The thresholds in config when the outputs were captured.
    expect(result.baseline).toEqual({
      minRelevance: 1.5,
      maxHype: 0.5,
      maxMinorRelease: 0.5,
      guardFlag: 0.5,
    });
    expect(result.proposed).toEqual({
      minRelevance: 1.5,
      maxHype: 0.35,
      maxMinorRelease: 0.65,
      guardFlag: 0.35,
    });
    expect(result.split?.holdout.weeks).toEqual(['2026-W40', '2026-W41']);
  });

  it('scores train and holdout the way the README reports', async () => {
    const { raw } = await committedLight();
    const scores = tuneThresholds(raw).scores;
    expect(scores?.train.filterAccuracy).toBeCloseTo(0.825, 3);
    expect(scores?.holdout.filterAccuracy).toBeCloseTo(0.9, 3);
    expect(scores?.train.classifierAccuracy).toBeCloseTo(0.3, 3);
    expect(scores?.holdout.classifierAccuracy).toBeCloseTo(0.2, 3);
    expect(scores?.warnings).toEqual([]);
  });

  describe('written by the sweep command', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'thresholds-committed-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('has the committed result file, key for key in the same order', async () => {
      const { name } = await committedLight();
      const io: CliIo = {
        casesDir: '/unused',
        outDir: dir,
        clock: fixedClock('2026-10-17T10:00:00Z'),
        stdout: () => undefined,
        stderr: () => undefined,
        openCapture: () => Promise.reject(new Error('unused')),
        loadEvalSet: () => Promise.reject(new Error('unused')),
      };
      expect(await sweepCommand(join(THRESHOLDS_DIR, 'raw', name), undefined, io)).toBe(0);
      // The file is named by the local date of capturedAt, so read whichever name was written.
      const [written] = await readdir(dir);
      // Compact JSON, so the repo's prettier layout (not the temp folder's) is not compared.
      const compact = async (path: string): Promise<string> =>
        JSON.stringify(JSON.parse(await readFile(path, 'utf8')));
      expect(await compact(join(dir, written!))).toBe(await compact(join(THRESHOLDS_DIR, name)));
    });
  });

  describe('written by the capture command', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'thresholds-committed-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const parsedFile = async (path: string): Promise<Record<string, unknown[] | object>> =>
      JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown[] | object>;
    /** The keys of a value at every depth, in order; an array is described by its first element. */
    const keyShape = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.length === 0 ? [] : [keyShape(value[0])];
      if (typeof value !== 'object' || value === null) return typeof value;
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, keyShape(v)]));
    };

    it('has the keys of the committed raw capture, in the same order', async () => {
      const { name } = await committedLight();
      const committed = await parsedFile(join(THRESHOLDS_DIR, 'raw', name));
      const scripted = scriptedModel();
      const io: CliIo = {
        casesDir: '/unused',
        outDir: dir,
        clock: fixedClock('2026-10-17T10:00:00Z'),
        stdout: () => undefined,
        stderr: () => undefined,
        openCapture: () =>
          Promise.resolve({
            profile: 'light',
            models: { classify: 'c', guardPolicy: 'p', guardRisk: 'g' },
            ollamaVersion: '0.40.4',
            baseline: { minRelevance: 1.5, maxHype: 0.5, maxMinorRelease: 0.5, guardFlag: 0.5 },
            deps: captureDeps(scripted),
            close: () => Promise.resolve(),
          }),
        loadEvalSet: () => Promise.resolve(evalSet()),
      };
      expect(await captureCommand({ config: undefined, force: false }, io)).toBe(0);
      const [written] = await readdir(join(dir, 'raw'));
      const fresh = await parsedFile(join(dir, 'raw', written!));
      expect(Object.keys(fresh)).toEqual(Object.keys(committed));
      for (const phase of ['classifier', 'weekItems', 'inputGuards', 'outputGuards'] as const) {
        // JSON.stringify keeps key order, so equal strings mean equal keys in equal order.
        expect(JSON.stringify(keyShape(fresh[phase]))).toBe(
          JSON.stringify(keyShape(committed[phase])),
        );
      }
      for (const key of ['models', 'baseline', 'timingsMs'] as const) {
        expect(Object.keys(fresh[key]!)).toEqual(Object.keys(committed[key]!));
      }
    });
  });
});
