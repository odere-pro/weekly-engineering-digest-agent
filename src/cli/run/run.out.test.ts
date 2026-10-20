import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../domain/schemas';
import type { RunRecord } from '../../store/runRecord';
import { makeRunRecord } from '../../../test/builders';
import { DATA_DIR, harness, sentResult, text } from './__fixtures__/runHarness';
import { runCommand } from './run';

describe('runCommand: --out', () => {
  it('overrides delivery.markdown.dir for the app it builds', async () => {
    const h = harness();

    await runCommand({ out: 'my/digests' }, h.deps);

    const built = h.buildApp.mock.calls[0]![0];
    expect(built.config.delivery.markdown.dir).toBe('my/digests');
    expect(h.loaded.config.delivery.markdown.dir).toBeUndefined();
  });

  it('keeps every other setting of the loaded config', async () => {
    const h = harness();

    await runCommand({ out: 'my/digests', seed: 7 }, h.deps);

    const built = h.buildApp.mock.calls[0]![0];
    expect(built.config.models.seed).toBe(7);
    expect(built.config.dataDir).toBe(DATA_DIR);
    expect(built.secrets).toBe(h.loaded.secrets);
  });

  it("uses the configured folder, by default the week's digest folder, without --out", async () => {
    const h = harness();

    await runCommand({}, h.deps);

    expect(h.buildApp.mock.calls[0]![0]).toBe(h.loaded);
    expect(h.loaded.config.delivery.markdown.dir).toBeUndefined();
  });

  it('uses the folder as given, absolute or relative', async () => {
    const h = harness();
    const absolute = join(tmpdir(), 'digests-out');

    await runCommand({ out: absolute }, h.deps);
    await runCommand({ out: './here' }, h.deps);

    expect(h.buildApp.mock.calls[0]![0].config.delivery.markdown.dir).toBe(absolute);
    expect(h.buildApp.mock.calls[1]![0].config.delivery.markdown.dir).toBe('./here');
  });

  it.each(['', '   '])(
    'rejects the blank --out "%s" before touching config or models',
    async (out) => {
      const h = harness();

      const code = await runCommand({ out }, h.deps);

      expect(code).toBe(1);
      expect(text(h.err)).toContain('--out');
      expect(h.loadConfig).not.toHaveBeenCalled();
      expect(h.buildApp).not.toHaveBeenCalled();
      expect(h.runDigest).not.toHaveBeenCalled();
    },
  );
});

describe('runCommand: local files', () => {
  let root: string;
  let digestsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-cmd-local-'));
    digestsDir = join(root, 'digests');
    await mkdir(digestsDir);
    await writeFile(join(digestsDir, '2026-W43.md'), '# Digest\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deliveredToMarkdown: Partial<RunRecord> = { deliveredTo: ['markdown', 'email'] };

  it('prints the Markdown and HTML paths of a sent run that wrote both', async () => {
    await writeFile(join(digestsDir, '2026-W43.html'), '<p>Digest</p>');
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: digestsDir });

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain(`Markdown  ${join(digestsDir, '2026-W43.md')}\n`);
    expect(text(h.out)).toContain(`HTML      ${join(digestsDir, '2026-W43.html')}\n`);
  });

  it('prints only the Markdown path when no HTML copy was written', async () => {
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: digestsDir });

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
    expect(text(h.out)).not.toMatch(/HTML/);
  });

  it('names the folder given with --out', async () => {
    const h = harness(sentResult(deliveredToMarkdown));

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
  });

  it('keeps the run folder digest line next to the local files', async () => {
    const h = harness(sentResult(deliveredToMarkdown));

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).toContain(join(DATA_DIR, '2026-10-19', 'digest', 'digest.md'));
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
  });

  it('prints the paths of a failed run whose Markdown channel took the digest', async () => {
    const h = harness({
      ...sentResult({ status: 'failed', deliveredTo: ['markdown'] }),
      exitCode: ExitCode.Failed,
    });

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
  });

  it.each([
    ['a week with a digest sent earlier', 'skipped'],
    ['a quiet week', 'quiet'],
    ['a blocked week', 'blocked'],
  ] as const)('prints no local path for %s', async (_name, status) => {
    const h = harness({ record: makeRunRecord({ runId: '2026-W43', status }), exitCode: 0 });

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).not.toContain(digestsDir);
  });

  it('lists only the files that are there: a resumed week may have written them elsewhere', async () => {
    await rm(join(digestsDir, '2026-W43.md'));
    await writeFile(join(digestsDir, '2026-W43.html'), '<p>Digest</p>');
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: digestsDir });

    await runCommand({}, h.deps);

    expect(text(h.out)).not.toContain(digestsDir);
  });

  it('lists no file it cannot check, and still prints the summary with the exit code of the run', async () => {
    // A link that loops: stat fails with ELOOP, which says nothing about whether a file is there.
    const loop = join(root, 'loop');
    await symlink(loop, loop);
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: loop });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(ExitCode.Sent);
    expect(text(h.out)).toContain('Week');
    expect(text(h.out)).not.toContain(loop);
    expect(text(h.err)).toBe('');
  });

  it('prints no local path when the Markdown channel was not reached', async () => {
    const h = harness({
      ...sentResult({ status: 'failed', deliveredTo: ['email'] }),
      exitCode: ExitCode.Failed,
    });

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).not.toContain(digestsDir);
  });
});
