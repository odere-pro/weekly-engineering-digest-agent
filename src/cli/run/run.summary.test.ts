import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../domain/schemas';
import { makeRunRecord } from '../../../test/builders';
import { DATA_DIR, harness, sentResult, text } from './__fixtures__/runHarness';
import { runCommand } from './run';

describe('runCommand: summary', () => {
  it('prints week, status, item counts, winner, digest path and duration for a sent run', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    const summary = text(h.out);
    expect(summary).toMatch(/Week\s+2026-W43/);
    expect(summary).toMatch(/Status\s+sent/);
    expect(summary).toMatch(/Items\s+120 collected → 4 in digest/);
    expect(summary).toMatch(/Winner\s+qwen3\.5:27b/);
    // 2026-10-19 is the Monday of 2026-W43.
    expect(summary).toContain(join(DATA_DIR, '2026-10-19', 'digest', 'digest.md'));
    expect(summary).toMatch(/Duration\s+7m 12s/);
    expect(text(h.err)).toBe('');
  });

  it('says that a dry run sent nothing', async () => {
    const h = harness(sentResult({ status: 'dry-run', dryRun: true }));

    await runCommand({ dryRun: true }, h.deps);

    expect(text(h.out)).toMatch(/Status\s+dry-run/);
    expect(text(h.out)).toMatch(/nothing was sent/i);
  });

  it('points at --force when the week was already sent', async () => {
    const h = harness({
      record: makeRunRecord({ runId: '2026-W43', status: 'skipped' }),
      exitCode: ExitCode.Sent,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(text(h.out)).toMatch(/Status\s+skipped/);
    expect(text(h.out)).toContain('--force');
    expect(text(h.out)).not.toContain('digest.md');
  });

  it('says why the week kept its files, under the summary, and names no digest path', async () => {
    const kept = 'Kept the sent run record; this forced run did not end sent';
    const h = harness({
      ...sentResult({ status: 'dry-run', dryRun: true }),
      markdown: undefined,
      kept,
    });

    await runCommand({ force: true, dryRun: true }, h.deps);

    const lines = text(h.out).trimEnd().split('\n');
    expect(lines.at(-1)).toBe(`${kept}. The week's run folder is unchanged.`);
    expect(lines).toContain('Dry run: nothing was sent.');
    expect(text(h.out)).not.toContain('digest.md');
    expect(text(h.err)).toBe('');
  });

  it('prints the reason on stdout and the error of a failed forced run on stderr', async () => {
    const kept = 'Kept the partly delivered run record; this run delivered nothing';
    const h = harness({
      record: makeRunRecord({
        runId: '2026-W43',
        status: 'failed',
        error: { step: 'write', message: 'Every writer failed' },
      }),
      exitCode: ExitCode.Failed,
      kept,
    });

    const code = await runCommand({ force: true }, h.deps);

    expect(code).toBe(1);
    expect(text(h.out)).toContain(`${kept}. The week's run folder is unchanged.`);
    expect(text(h.err)).toBe('Error (step: write): Every writer failed\n');
  });

  it('prints no keep note when the run saved its record', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    expect(text(h.out)).not.toContain('Kept');
    expect(text(h.out)).not.toContain('unchanged');
  });

  it('shows no winner and no digest path for a quiet week', async () => {
    const h = harness({
      record: makeRunRecord({ runId: '2026-W43', status: 'quiet', winner: null }),
      exitCode: ExitCode.Quiet,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(3);
    expect(text(h.out)).toMatch(/Status\s+quiet/);
    expect(text(h.out)).toMatch(/Winner\s+-/);
    expect(text(h.out)).not.toContain('digest.md');
  });

  it('prints the error of a failed run on stderr, with its step', async () => {
    const h = harness({
      record: makeRunRecord({
        runId: '2026-W43',
        status: 'failed',
        error: { message: 'No draft passed the link check', step: 'guardOutput' },
      }),
      exitCode: ExitCode.Failed,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.out)).toMatch(/Status\s+failed/);
    expect(text(h.err)).toContain('No draft passed the link check');
    expect(text(h.err)).toContain('guardOutput');
  });

  it('lists the failed sources', async () => {
    const h = harness(
      sentResult({
        failedSources: [{ sourceId: 'broken-feed', error: 'timeout after 10 s' }],
      }),
    );

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain('broken-feed');
    expect(text(h.out)).toContain('timeout after 10 s');
  });

  it('shows durations under a minute in seconds', async () => {
    const h = harness(
      sentResult({ startedAt: '2026-10-19T05:45:00Z', finishedAt: '2026-10-19T05:45:07.500Z' }),
    );

    await runCommand({}, h.deps);

    expect(text(h.out)).toMatch(/Duration\s+7\.5s/);
  });
});

describe('runCommand: rejected drafts', () => {
  it('names the drafts that were rejected and by which check', async () => {
    const h = harness({
      record: makeRunRecord({
        runId: '2026-W43',
        status: 'blocked',
        drafts: [
          { writer: 'qwen3.5:27b', passed: false, rejectedBy: ['linkCheck', 'formatCheck'] },
          { writer: 'gemma4:31b', passed: true, rejectedBy: [] },
        ],
      }),
      exitCode: ExitCode.Blocked,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(2);
    expect(text(h.out)).toContain('Rejected draft: qwen3.5:27b (linkCheck, formatCheck)');
    expect(text(h.out)).not.toContain('gemma4:31b');
  });
});

describe('runCommand: secrets', () => {
  const secrets = { SMTP_PASSWORD: 'hunter2-smtp', GITHUB_TOKEN: 'ghp_token123' };

  it('redacts secrets from a thrown error', async () => {
    const h = harness(new Error('SMTP login failed for hunter2-smtp'));
    h.loadConfig.mockResolvedValue({ ...h.loaded, secrets });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toBe('SMTP login failed for [redacted]\n');
  });

  it('redacts secrets from the summary and the run error', async () => {
    const h = harness(
      sentResult({
        status: 'failed',
        failedSources: [{ sourceId: 'gh', error: 'bad credentials ghp_token123' }],
        error: { message: 'delivery failed: hunter2-smtp', step: 'deliver' },
      }),
    );
    h.loadConfig.mockResolvedValue({ ...h.loaded, secrets });

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain('bad credentials [redacted]');
    expect(text(h.err)).toContain('delivery failed: [redacted]');
    expect(text(h.out) + text(h.err)).not.toMatch(/hunter2-smtp|ghp_token123/);
  });
});
