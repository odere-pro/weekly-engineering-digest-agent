import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThresholdsSchema } from '../../../src/config/schema';
import { fixedClock } from '../../../src/shared/clock';
import { captureDeps, evalSet, scriptedModel, type Scripted } from '../__fixtures__/captureKit';
import { RawCaptureSchema } from '../capture/schemas';
import { captureCommand } from './captureCommand';
import type { CaptureSession, CliIo } from './io';

// `localDate` names a file after the machine's calendar day, so each clock is set from local parts:
// local noon on a day is that day in every time zone, and the expected names can be literal.
const CAPTURE_CLOCK = fixedClock(new Date(2026, 9, 17, 12));
const LATER_CLOCK = fixedClock(new Date(2026, 10, 3, 12));

let dir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thresholds-capture-'));
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function session(scripted: Scripted, onClose: () => void = () => undefined): CaptureSession {
  return {
    profile: 'light',
    models: { classify: 'decider', guardPolicy: 'decider', guardRisk: 'granite' },
    ollamaVersion: '0.40.4',
    baseline: ThresholdsSchema.parse({}),
    deps: captureDeps(scripted),
    close: () => {
      onClose();
      return Promise.resolve();
    },
  };
}

function io(scripted: Scripted, overrides: Partial<CliIo> = {}, onClose?: () => void): CliIo {
  return {
    casesDir: '/unused',
    outDir: dir,
    clock: CAPTURE_CLOCK,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    openCapture: () => Promise.resolve(session(scripted, onClose)),
    loadEvalSet: () => Promise.resolve(evalSet()),
    ...overrides,
  };
}

const options = { config: undefined, force: false };

describe('captureCommand', () => {
  it('captures with the session the config opens and saves the raw outputs', async () => {
    let closed = false;
    const code = await captureCommand(
      { config: 'dist/thresholds/light.json', force: false },
      io(scriptedModel(), {}, () => (closed = true)),
    );
    expect(code).toBe(0);
    expect(closed).toBe(true);
    const [name] = await readdir(join(dir, 'raw'));
    expect(name).toBe('2026-10-17-light.json');
    const raw = RawCaptureSchema.parse(JSON.parse(await readFile(join(dir, 'raw', name!), 'utf8')));
    expect(raw.classifier).toHaveLength(2);
    expect(raw.baseline).toEqual(ThresholdsSchema.parse({}));
    expect(raw.profile).toBe('light');
    expect(raw.focusAreas).toHaveLength(2);
    expect(out.join('')).toContain(`Saved ${join(dir, 'raw', name!)}`);
  });

  it('passes the config path to the session it opens', async () => {
    const seen: (string | undefined)[] = [];
    const scripted = scriptedModel();
    await captureCommand(
      { config: 'dist/thresholds/light.json', force: false },
      io(scripted, {
        openCapture: (configPath) => {
          seen.push(configPath);
          return Promise.resolve(session(scripted));
        },
      }),
    );
    expect(seen).toEqual(['dist/thresholds/light.json']);
  });

  it('reports progress on stderr, starting with the profile and its models', async () => {
    await captureCommand(options, io(scriptedModel()));
    expect(err[0]).toBe(
      'Capturing light: {"classify":"decider","guardPolicy":"decider","guardRisk":"granite"}\n',
    );
    expect(err.join('')).toContain('classifier cases: 2/2\n');
  });

  it('saves a capture with failed calls but exits 1 and counts them', async () => {
    expect(await captureCommand(options, io(scriptedModel('patch')))).toBe(1);
    expect(await readdir(join(dir, 'raw'))).toEqual(['2026-10-17-light.json']);
    expect(err.join('')).toContain('model calls failed: {"classifier":1,"weekItems":1');
  });

  it('refuses to replace an earlier capture unless force is set, before it loads any case', async () => {
    expect(await captureCommand(options, io(scriptedModel()))).toBe(0);
    let loads = 0;
    const counting = io(scriptedModel(), {
      loadEvalSet: () => ((loads += 1), Promise.resolve(evalSet())),
    });
    await expect(captureCommand(options, counting)).rejects.toThrow('exists; pass --force');
    expect(loads).toBe(0);
    expect(await captureCommand({ ...options, force: true }, counting)).toBe(0);
    expect(loads).toBe(1);
  });

  it('keeps the file but fails when the capture does not match its schema', async () => {
    const scripted = scriptedModel();
    const invalid = {
      ...session(scripted),
      baseline: { ...ThresholdsSchema.parse({}), maxHype: 5 },
    };
    const bad = io(scripted, { openCapture: () => Promise.resolve(invalid) });
    await expect(captureCommand(options, bad)).rejects.toThrow('is not a valid raw capture');
    expect(await readdir(join(dir, 'raw'))).toEqual(['2026-10-17-light.json']);
  });

  it('closes the session when the eval set cannot be loaded', async () => {
    let closed = false;
    const failing = io(
      scriptedModel(),
      { loadEvalSet: () => Promise.reject(new Error('no cases')) },
      () => (closed = true),
    );
    await expect(captureCommand(options, failing)).rejects.toThrow('no cases');
    expect(closed).toBe(true);
  });

  it('names the file after the local date of the clock and the profile', async () => {
    const scripted = scriptedModel();
    const later = io(scripted, { clock: LATER_CLOCK });
    await captureCommand(options, later);
    expect(await readdir(join(dir, 'raw'))).toEqual(['2026-11-03-light.json']);
  });
});
