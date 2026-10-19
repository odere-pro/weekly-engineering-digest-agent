import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app/container';
import { loadConfig } from '../src/config/load';
import { ThresholdsSchema } from '../src/config/schema';
import { fixedClock } from '../src/shared/clock';
import { fakeApp, loadedConfig } from './thresholds/__fixtures__/appKit';
import {
  captureDeps,
  evalSet,
  scriptedModel,
  type Scripted,
} from './thresholds/__fixtures__/captureKit';
import { ATTACKS, policy, rawCapture, repeat } from './thresholds/__fixtures__/records';
import { RawCaptureSchema } from './thresholds/capture/schemas';
import { localDate } from './thresholds/cli/files';
import type { CaptureSession, CliIo } from './thresholds/cli/io';
import { TuningResultSchema } from './thresholds/result/schema';
import { runCli } from './tuneThresholds';

vi.mock('../src/config/load', () => ({ loadConfig: vi.fn() }));
vi.mock('../src/app/container', () => ({ buildApp: vi.fn() }));

// The command line: arguments in, exit code and text out. What each command does is tested
// beside it in thresholds/cli/.

describe('runCli', () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tune-thresholds-'));
    out = [];
    err = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function io(overrides: Partial<CliIo> = {}): Partial<CliIo> {
    return {
      outDir: dir,
      clock: fixedClock('2026-10-17T10:00:00Z'),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      ...overrides,
    };
  }

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

  function captureIo(scripted: Scripted, onClose?: () => void): Partial<CliIo> {
    return io({
      openCapture: () => Promise.resolve(session(scripted, onClose)),
      loadEvalSet: () => Promise.resolve(evalSet()),
    });
  }

  it('sweeps a raw capture into <date>-<profile>.json and prints the proposal', async () => {
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify(rawCapture()));
    expect(await runCli(['sweep', rawPath], io())).toBe(0);
    const saved = TuningResultSchema.parse(
      JSON.parse(
        await readFile(join(dir, `${localDate(rawCapture().capturedAt)}-light.json`), 'utf8'),
      ),
    );
    expect(saved.proposed.guardFlag).toBe(0.55);
    expect(out.join('')).toContain('guardFlag');
  });

  it('captures with the session the config opens and saves the raw outputs', async () => {
    let closed = false;
    const code = await runCli(
      ['capture', '--config', 'data/thresholds/light.json'],
      captureIo(scriptedModel(), () => (closed = true)),
    );
    expect(code).toBe(0);
    expect(closed).toBe(true);
    const [name] = await readdir(join(dir, 'raw'));
    expect(name).toBe('2026-10-17-light.json');
    const raw = RawCaptureSchema.parse(JSON.parse(await readFile(join(dir, 'raw', name!), 'utf8')));
    expect(raw.classifier).toHaveLength(2);
    expect(raw.baseline).toEqual(ThresholdsSchema.parse({}));
  });

  it('hands --config to the session it opens', async () => {
    const seen: (string | undefined)[] = [];
    const scripted = scriptedModel();
    const code = await runCli(
      ['capture', '--config', 'data/thresholds/light.json'],
      io({
        openCapture: (configPath) => {
          seen.push(configPath);
          return Promise.resolve(session(scripted));
        },
        loadEvalSet: () => Promise.resolve(evalSet()),
      }),
    );
    expect(code).toBe(0);
    expect(seen).toEqual(['data/thresholds/light.json']);
  });

  it('saves a capture with failed calls but exits 1 and counts them', async () => {
    expect(await runCli(['capture'], captureIo(scriptedModel('patch')))).toBe(1);
    expect(await readdir(join(dir, 'raw'))).toEqual(['2026-10-17-light.json']);
    expect(err.join('')).toContain('model calls failed: {"classifier":1,"weekItems":1');
  });

  it('refuses to replace an earlier capture unless --force is given', async () => {
    expect(await runCli(['capture'], captureIo(scriptedModel()))).toBe(0);
    let calls = 0;
    const scripted = scriptedModel();
    const counting = {
      ...captureIo(scripted),
      loadEvalSet: () => ((calls += 1), Promise.resolve(evalSet())),
    };
    expect(await runCli(['capture'], counting)).toBe(1);
    expect(err.join('')).toContain('exists; pass --force');
    expect(calls).toBe(0);
    expect(await runCli(['capture', '--force'], counting)).toBe(0);
  });

  it('closes the session when the eval set cannot be loaded', async () => {
    let closed = false;
    const failing = {
      ...captureIo(scriptedModel(), () => (closed = true)),
      loadEvalSet: () => Promise.reject(new Error('no cases')),
    };
    expect(await runCli(['capture'], failing)).toBe(1);
    expect(closed).toBe(true);
    expect(err.join('')).toContain('tuneThresholds failed: no cases');
  });

  it('sweeps with --holdout weeks and prints train and holdout side by side', async () => {
    const rawPath = join(dir, 'raw.json');
    const weeks = ['2026-W38', '2026-W39', '2026-W40'];
    const clean = weeks.flatMap((week) =>
      repeat(20, () => ({ ...policy('clean', 0.01), from: week })),
    );
    await writeFile(rawPath, JSON.stringify(rawCapture({ inputGuards: [...clean, ...ATTACKS] })));
    expect(await runCli(['sweep', rawPath, '--holdout', '2026-W39,2026-W40'], io())).toBe(0);
    const text = out.join('');
    expect(text).toMatch(/train\s+holdout\s+gap/);
    expect(text).toContain('held out:');
    expect(text).toContain('2026-W39, 2026-W40');
  });

  it('exits 2 when capture is given --holdout, which only sweep reads', async () => {
    expect(await runCli(['capture', '--holdout', '2026-W40'], io())).toBe(2);
    expect(err.join('')).toContain('belongs to sweep');
  });

  it('exits 2 for a --holdout that is not a list of week ids', async () => {
    expect(await runCli(['sweep', 'raw.json', '--holdout', 'tomorrow'], io())).toBe(2);
    expect(err.join('')).toContain('not a week id');
  });

  it('exits 1 for a --holdout week the capture does not have', async () => {
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify(rawCapture()));
    expect(await runCli(['sweep', rawPath, '--holdout', '2026-W01'], io())).toBe(1);
    expect(err.join('')).toContain('no week 2026-W01');
  });

  it('exits 2 with the reason for an unknown option or an extra argument', async () => {
    expect(await runCli(['sweep', 'a.json', '--fast'], io())).toBe(2);
    expect(await runCli(['sweep', 'a.json', 'b.json'], io())).toBe(2);
    expect(err.join('')).toContain('unexpected b.json');
  });

  it('prints usage and exits 2 for an unknown command, and for sweep without a file', async () => {
    expect(await runCli(['tune'], io())).toBe(2);
    expect(err.join('')).toContain('Usage');
    err.length = 0;
    expect(await runCli(['sweep'], io())).toBe(2);
    expect(err.join('')).toContain('tsx evals/tuneThresholds.ts sweep <evals/thresholds/raw/');
  });

  it('exits 1 with a readable message when the raw file does not match its schema', async () => {
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify({ profile: 'light' }));
    expect(await runCli(['sweep', rawPath], io())).toBe(1);
    expect(err.join('')).toContain(rawPath);
  });
});

describe('runCli wiring', () => {
  it('builds the app from the --config file and checks Ollama before it captures', async () => {
    const { handle, closed } = fakeApp({ reachable: false, models: [], error: 'ECONNREFUSED' });
    const loaded = loadedConfig();
    vi.mocked(loadConfig).mockResolvedValue(loaded);
    vi.mocked(buildApp).mockResolvedValue(handle);
    const err: string[] = [];
    const code = await runCli(['capture', '--config', 'data/thresholds/light.json'], {
      stderr: (text) => err.push(text),
    });
    expect(code).toBe(1);
    expect(loadConfig).toHaveBeenCalledWith({ configPath: 'data/thresholds/light.json' });
    expect(buildApp).toHaveBeenCalledWith(loaded);
    expect(err.join('')).toContain('tuneThresholds failed: Ollama is not reachable: ECONNREFUSED');
    expect(closed()).toBe(1);
  });

  it('writes the summary to the process stdout by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tune-thresholds-'));
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const rawPath = join(dir, 'raw.json');
      await writeFile(rawPath, JSON.stringify(rawCapture()));
      expect(await runCli(['sweep', rawPath], { outDir: dir })).toBe(0);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('light: 4 classifier cases'));
    } finally {
      write.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runCli files and streams', () => {
  it('exits 1 naming the file when the raw capture does not exist', async () => {
    const err: string[] = [];
    const code = await runCli(['sweep', '/nonexistent/raw.json'], {
      stderr: (text) => err.push(text),
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('Cannot read /nonexistent/raw.json');
  });

  it('prints n/a for numbers it could not measure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tune-thresholds-'));
    try {
      const rawPath = join(dir, 'raw.json');
      await writeFile(rawPath, JSON.stringify(rawCapture({ inputGuards: [], outputGuards: [] })));
      const out: string[] = [];
      expect(await runCli(['sweep', rawPath], { outDir: dir, stdout: (t) => out.push(t) })).toBe(0);
      expect(out.join('')).toContain('clefPolicy false blocks n/a');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes usage to the process stderr by default', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await runCli([])).toBe(2);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    } finally {
      write.mockRestore();
    }
  });
});
