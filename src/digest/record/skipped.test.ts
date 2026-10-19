import { describe, expect, it } from 'vitest';
import { skipped } from './skipped';
import { ExitCode } from '../../domain/schemas';
import { WEEK, contextFor } from '../__fixtures__/stageKit';

describe('skipped', () => {
  it('returns a skipped record and its exit code, without a digest or a message', () => {
    const { ctx } = contextFor();

    const result = skipped(ctx);

    expect(result.record).toMatchObject({ runId: WEEK, status: 'skipped', winner: null });
    expect(result.exitCode).toBe(ExitCode.Sent);
    expect(result).not.toHaveProperty('markdown');
    expect(result).not.toHaveProperty('message');
  });

  it('saves nothing: the sent record of the week stays as it is', () => {
    const h = contextFor();

    skipped(h.ctx);

    expect(h.store.records.size).toBe(0);
    expect(h.store.artifacts.size).toBe(0);
  });

  it('says why in the log', () => {
    const h = contextFor();

    skipped(h.ctx);

    expect(h.logs).toEqual([
      {
        level: 'info',
        message: 'Week already has a sent digest; skipped (use --force to run it again)',
        fields: { runId: WEEK },
      },
    ]);
  });
});
