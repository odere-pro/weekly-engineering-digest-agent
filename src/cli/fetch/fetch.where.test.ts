import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../test/fakes';
import { fetchCommand } from './fetch';
import {
  DAY,
  RSS,
  ATOM,
  allFiles,
  harness,
  pathsIn,
  sourceFiles,
  useTempDir,
  type Harness,
  type HarnessOptions,
} from './__fixtures__/fetchHarness';

const dir = useTempDir();
const setup = (options: HarnessOptions = {}): Promise<Harness> => harness(dir(), options);
const paths = (): ReturnType<typeof pathsIn> => pathsIn(dir());

describe('fetchCommand: where it writes', () => {
  it("writes only the day's source folders and summary into the data folder", async () => {
    const h = await setup({ sources: [RSS, ATOM] });

    await fetchCommand({}, h.deps);

    expect(await readdir(dir())).toEqual(['data']);
    expect(await readdir(paths().runFolder)).toEqual([
      'example-atom',
      'example-feed',
      'fetch-summary.json',
    ]);
  });

  it("leaves the week's digest, the lock and other days alone", async () => {
    await mkdir(join(paths().runFolder, 'digest'), { recursive: true });
    await writeFile(join(paths().runFolder, 'digest', 'run.json'), '{}');
    await mkdir(join(paths().outputRoot, '2026-10-12', 'example-feed', 'raw'), { recursive: true });
    await writeFile(join(paths().outputRoot, 'digest.lock'), 'held');
    const h = await setup();

    await fetchCommand({}, h.deps);

    expect(await readFile(join(paths().runFolder, 'digest', 'run.json'), 'utf8')).toBe('{}');
    expect(await readFile(join(paths().outputRoot, 'digest.lock'), 'utf8')).toBe('held');
    expect(await readdir(join(paths().outputRoot, '2026-10-12', 'example-feed'))).toEqual(['raw']);
  });

  it("replaces a source's files from an earlier fetch that day", async () => {
    await mkdir(join(paths().runFolder, 'example-feed', 'raw'), { recursive: true });
    await writeFile(join(paths().runFolder, 'example-feed', 'raw', 'response-2.xml'), 'old');
    await writeFile(paths().summaryPath, 'from an earlier fetch');
    const h = await setup();

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(0);
    expect(await allFiles(paths().runFolder)).toEqual([
      ...sourceFiles('example-feed', 'xml'),
      'fetch-summary.json',
    ]);
    expect(await readFile(paths().summaryPath, 'utf8')).not.toBe('from an earlier fetch');
  });

  it('writes into another folder with --out, resolved against the working directory', async () => {
    const h = await setup();

    const code = await fetchCommand({ out: 'elsewhere' }, h.deps);

    expect(code).toBe(0);
    expect(await readdir(join(dir(), 'elsewhere'))).toEqual([DAY]);
    expect(await readdir(dir())).toEqual(['elsewhere']);
  });

  it('names the day in the time zone of the schedule', async () => {
    const h = await setup({ clock: fixedClock('2026-10-13T22:30:00Z') });

    await fetchCommand({}, h.deps);

    // 00:30 on 14 October in Berlin.
    expect(await readdir(paths().outputRoot)).toEqual(['2026-10-14']);
  });

  it('fails with the reason, before any request, when the output folder cannot be written', async () => {
    await writeFile(join(dir(), 'taken'), 'a file, not a folder');
    const h = await setup();

    const code = await fetchCommand({ out: 'taken' }, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toMatch(/ENOTDIR|EEXIST/);
    expect(h.calls).toEqual([]);
  });
});
