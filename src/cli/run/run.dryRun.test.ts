import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMarkdownFileDelivery } from '../../delivery/adapters/markdownFile';
import type { DigestMessage } from '../../delivery/Delivery';
import type { RunResult } from '../../digest/types';
import { ExitCode } from '../../domain/schemas';
import type { DigestView } from '../../render/digestView';
import { makeRunRecord } from '../../../test/builders';
import { CapturingDelivery } from '../../../test/fakes';
import { harness, sentResult, text } from './__fixtures__/runHarness';
import { runCommand } from './run';

describe('runCommand: dry run', () => {
  const VIEW: DigestView = {
    weekId: '2026-W43',
    title: 'Week 2026-W43: 1 release, 1 needs action',
    headline: 'One thing to do.',
    groups: [
      {
        urgency: 'act-now',
        label: 'Act now',
        items: [
          {
            title: 'Gateway 2.0',
            url: 'https://example.com/gateway',
            whatChanged: 'The v1 API is removed.',
            action: 'Move off v1.',
          },
        ],
      },
    ],
  };
  const MARKDOWN = '# Week 2026-W43\n\n| Release |\n';

  /** A dry run result; `message` is what a run hands over once its core attaches the view. */
  function dryRun(message?: DigestMessage): RunResult & { message?: DigestMessage } {
    return {
      ...sentResult({ status: 'dry-run', dryRun: true }, MARKDOWN),
      ...(message && { message }),
    };
  }

  let root: string;
  let digestsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-cmd-dry-'));
    digestsDir = join(root, 'digests');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the digest to the local folder through the Markdown channel only', async () => {
    const markdown = new CapturingDelivery('markdown');
    const email = new CapturingDelivery('email');
    const slack = new CapturingDelivery('slack');
    const h = harness(dryRun(), { deliveries: [markdown, email, slack] });

    const code = await runCommand({ dryRun: true }, h.deps);

    expect(code).toBe(0);
    expect(markdown.digests).toEqual([
      { weekId: '2026-W43', subject: 'Engineering digest 2026-W43', markdown: MARKDOWN },
    ]);
    expect(email.digests).toEqual([]);
    expect(slack.digests).toEqual([]);
    expect(email.failures).toEqual([]);
    expect(slack.failures).toEqual([]);
  });

  it('writes <week>.md into the --out folder, and no HTML while the run has no view', async () => {
    const markdownChannel = createMarkdownFileDelivery({ dir: digestsDir });
    const h = harness(dryRun(), { deliveries: [markdownChannel] });

    await runCommand({ dryRun: true, out: digestsDir }, h.deps);

    expect(await readdir(digestsDir)).toEqual(['2026-W43.md']);
    expect(await readFile(join(digestsDir, '2026-W43.md'), 'utf8')).toBe(MARKDOWN);
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
    expect(text(h.out)).not.toMatch(/HTML/);
  });

  it("writes into the week's digest folder of the data folder when no folder is set", async () => {
    const dataDir = join(root, 'dist');
    const markdownChannel = createMarkdownFileDelivery({ dataDir });
    const h = harness(dryRun(), { deliveries: [markdownChannel], dataDir });

    await runCommand({ dryRun: true }, h.deps);

    const weekDir = join(dataDir, '2026-10-19', 'digest');
    expect(await readFile(join(weekDir, '2026-W43.md'), 'utf8')).toBe(MARKDOWN);
    expect(text(h.out)).toContain(join(weekDir, '2026-W43.md'));
  });

  it('writes the HTML copy too when the run hands over the message with its view', async () => {
    const message: DigestMessage = {
      weekId: '2026-W43',
      subject: 'Engineering digest 2026-W43: One thing to do.',
      markdown: MARKDOWN,
      view: VIEW,
    };
    const markdownChannel = createMarkdownFileDelivery({ dir: digestsDir });
    const h = harness(dryRun(message), { deliveries: [markdownChannel] });

    await runCommand({ dryRun: true, out: digestsDir }, h.deps);

    expect((await readdir(digestsDir)).sort()).toEqual(['2026-W43.html', '2026-W43.md']);
    expect(await readFile(join(digestsDir, '2026-W43.html'), 'utf8')).toContain('Gateway 2.0');
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.html'));
  });

  it('still says that nothing was sent', async () => {
    const h = harness(dryRun());

    await runCommand({ dryRun: true }, h.deps);

    expect(text(h.out)).toContain('Dry run: nothing was sent.');
  });

  it('writes nothing when the run kept the week earlier files', async () => {
    const markdown = new CapturingDelivery('markdown');
    const h = harness(
      {
        ...sentResult({ status: 'dry-run', dryRun: true }),
        markdown: undefined,
        kept: 'Kept the sent run record; this forced run did not end sent',
      },
      { deliveries: [markdown] },
    );

    await runCommand({ dryRun: true, force: true }, h.deps);

    expect(markdown.digests).toEqual([]);
    expect(text(h.out)).not.toContain('2026-W43.md');
  });

  it.each(['quiet', 'blocked', 'failed'] as const)(
    'writes nothing for a dry run that ended %s',
    async (status) => {
      const markdown = new CapturingDelivery('markdown');
      const h = harness(
        {
          record: makeRunRecord({ runId: '2026-W43', status, dryRun: true }),
          exitCode: ExitCode.Quiet,
          // A digest is there, so only the status stops the write.
          markdown: MARKDOWN,
        },
        { deliveries: [markdown] },
      );

      await runCommand({ dryRun: true }, h.deps);

      expect(markdown.digests).toEqual([]);
    },
  );

  it('does not write a second copy for a real run: the run delivered it already', async () => {
    const markdown = new CapturingDelivery('markdown');
    const h = harness(sentResult({ deliveredTo: ['markdown'] }), { deliveries: [markdown] });

    await runCommand({}, h.deps);

    expect(markdown.digests).toEqual([]);
  });

  it('writes nothing, and does not fail, when the app has no Markdown channel', async () => {
    const h = harness(dryRun(), { deliveries: [new CapturingDelivery('email')] });

    const code = await runCommand({ dryRun: true }, h.deps);

    expect(code).toBe(0);
    expect(text(h.err)).toBe('');
    expect(text(h.out)).not.toContain('2026-W43.md');
  });

  it('reports a failed local write on stderr, exits 1 and prints no local path', async () => {
    const markdown = new CapturingDelivery('markdown');
    markdown.failWith = new Error('EACCES: permission denied, mkdir');
    const h = harness(dryRun(), { deliveries: [markdown] });

    const code = await runCommand({ dryRun: true, out: '/nowhere' }, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toContain('/nowhere');
    expect(text(h.err)).toContain('EACCES: permission denied, mkdir');
    expect(text(h.out)).toMatch(/Status\s+dry-run/);
    expect(text(h.out)).not.toContain('2026-W43.md');
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('redacts secrets from a failed local write', async () => {
    const markdown = new CapturingDelivery('markdown');
    markdown.failWith = new Error('cannot write hunter2-smtp');
    const h = harness(dryRun(), { deliveries: [markdown] });
    h.loadConfig.mockResolvedValue({ ...h.loaded, secrets: { SMTP_PASSWORD: 'hunter2-smtp' } });

    await runCommand({ dryRun: true }, h.deps);

    expect(text(h.err)).toContain('cannot write [redacted]');
    expect(text(h.err)).not.toContain('hunter2-smtp');
  });
});
