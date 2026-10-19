// Failures, housekeeping and the classifier hints of a whole run, through runDigest.
import { describe, expect, it, vi } from 'vitest';
import { runDigest } from './runDigest';
import { ExitCode } from '../domain/schemas';
import type { LogFields } from '../shared/telemetry';
import { CapturingDelivery } from '../../test/fakes';
import {
  WEEK,
  WRITER_A,
  WRITER_B,
  PROFILE,
  healthyFor,
  setup,
  expectValidRecord,
  sentNotes,
  decideCalls,
} from './__fixtures__/runKit';

describe('runDigest: failures', () => {
  it('fails before collecting when Ollama is unreachable', async () => {
    const h = setup({
      health: { reachable: false, models: [], error: 'connect ECONNREFUSED 127.0.0.1:11434' },
    });

    const result = await h.run();

    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.record).toMatchObject({ status: 'failed', timings: [] });
    expectValidRecord(result.record);
    expect(result.record.error?.message).toContain('ECONNREFUSED');
    expect(h.fetcher.calls).toEqual([]);
    expect(JSON.parse(h.artifact('error.json')!)).toMatchObject({
      runId: WEEK,
      message: expect.stringContaining('not reachable') as string,
    });
    expect(sentNotes(h)).toHaveLength(2);
  });

  it('fails before collecting when a profile model is missing, naming it', async () => {
    const health = healthyFor(PROFILE);
    const h = setup({
      health: { ...health, models: health.models.filter((m) => m.name !== WRITER_B) },
    });

    const result = await h.run();

    expect(result.record.status).toBe('failed');
    expect(result.record.error?.message).toContain(WRITER_B);
    expect(result.record.error?.message).not.toContain(WRITER_A);
    expect(h.fetcher.calls).toEqual([]);
  });

  it('accepts models that Ollama lists with an implicit :latest tag', async () => {
    const profile = { ...PROFILE, classify: 'clef' };
    const health = healthyFor(PROFILE);
    const h = setup({
      profile,
      health: { ...health, models: [...health.models, { name: 'clef:latest', capabilities: [] }] },
    });

    const result = await h.run({ dryRun: true });

    expect(result.record.status).toBe('dry-run');
  });

  it('fails when the health check itself throws', async () => {
    const h = setup();
    vi.spyOn(h.model, 'health').mockRejectedValue(new Error('socket hang up'));

    const result = await h.run({ dryRun: true });

    expect(result.record.status).toBe('failed');
    expect(result.record.error?.message).toContain('socket hang up');
  });

  it('records the failed step, writes error.json, alerts every channel and releases the lock', async () => {
    const h = setup({ failClassify: new Error('classifier timed out') });

    const result = await h.run();

    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.record).toMatchObject({
      status: 'failed',
      counts: { collected: 5, afterGuardInput: 5, classified: 0 },
      error: { step: 'classify', message: 'classifier timed out' },
    });
    expectValidRecord(result.record);
    expect(result.record.timings.map((timing) => timing.step)).toEqual([
      'collect',
      'guardInput',
      'classify',
    ]);
    expect(JSON.parse(h.artifact('error.json')!)).toMatchObject({
      runId: WEEK,
      step: 'classify',
      message: 'classifier timed out',
    });
    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        { weekId: WEEK, step: 'classify', message: 'classifier timed out' },
      ]);
    }
    expect(h.store.isLocked).toBe(false);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ step: 'classify' }) as LogFields,
      }),
    );
  });

  it('still saves run.json and alerts when error.json cannot be written', async () => {
    const h = setup({ failClassify: new Error('classifier timed out') });
    const save = h.store.saveArtifact.bind(h.store);
    vi.spyOn(h.store, 'saveArtifact').mockImplementation((runId, name, content) =>
      name === 'error.json' ? Promise.reject(new Error('EROFS')) : save(runId, name, content),
    );

    const result = await h.run();

    expect(h.store.records.get(WEEK)?.status).toBe('failed');
    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(sentNotes(h)).toHaveLength(2);
  });

  it('sends no failure note in a dry run', async () => {
    const h = setup({ failClassify: new Error('classifier timed out') });

    const result = await h.run({ dryRun: true });

    expect(result.record.status).toBe('failed');
    expect(sentNotes(h)).toEqual([]);
  });

  it('logs a failure note that cannot be sent and still returns the failed run', async () => {
    class BrokenNotes extends CapturingDelivery {
      override sendFailure(): Promise<void> {
        return Promise.reject(new Error('webhook answered 500'));
      }
    }
    const h = setup({ health: { reachable: false, models: [] } });
    const deps = { ...h.deps, deliveries: [new BrokenNotes('slack')] };

    const result = await runDigest(deps);

    expect(result.record.status).toBe('failed');
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({
          delivery: 'slack',
          error: 'webhook answered 500',
        }) as LogFields,
      }),
    );
  });
});

describe('runDigest: housekeeping and model use', () => {
  it('prunes old runs with keepWeeks after saving the record', async () => {
    const h = setup({ config: { keepWeeks: 6 } });
    const prune = vi.spyOn(h.store, 'prune');

    await h.run({ dryRun: true });

    expect(prune).toHaveBeenCalledWith(WEEK, 6);
  });

  it('logs a failed prune without failing the run', async () => {
    const h = setup();
    vi.spyOn(h.store, 'prune').mockRejectedValue(new Error('EACCES'));

    const result = await h.run({ dryRun: true });

    expect(result.record.status).toBe('dry-run');
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ error: 'EACCES' }) as LogFields,
      }),
    );
  });

  it('uses one model at a time: no role or model is interleaved with another', async () => {
    const h = setup();

    await h.run({ dryRun: true });

    const blocks = h.timeline.filter((key, index) => key !== h.timeline[index - 1]);
    expect(blocks).toEqual([
      'guard:clefPolicy',
      'guard:graniteRisk',
      'classify',
      `write:${WRITER_A}`,
      `write:${WRITER_B}`,
      'guard:graniteGroundedness',
      'guard:clefRubric',
      'judge',
    ]);
  });
});

describe('runDigest: classifier hints', () => {
  const source = { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' } as const;

  it('passes the source area tag into every classify call', async () => {
    const h = setup({ config: { sources: [{ ...source, area: 'ai-tooling' }] } });

    await h.run();

    const states = decideCalls(h, 'classify').map((call) => call.state);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(state).toContain('Source tag: ai-tooling');
  });

  it('leaves the prompt without a tag when the source has no area', async () => {
    const h = setup();

    await h.run();

    const states = decideCalls(h, 'classify').map((call) => call.state);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(state).not.toContain('Source tag');
  });
});
