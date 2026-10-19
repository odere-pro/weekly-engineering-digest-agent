import { describe, expect, it } from 'vitest';
import { StepFailure } from './failures';
import { settle } from './settle';
import { EMPTY_STATE } from './state';
import { DigestError } from '../../shared/errors';
import { contextFor, stateOf } from '../__fixtures__/stageKit';

describe('settle', () => {
  it('returns the state the chain ended with, and no failure', async () => {
    const h = contextFor();
    const state = stateOf({ sentUrls: ['https://example.com/a'] });

    const outcome = await settle(h.ctx, () => Promise.resolve(state));

    expect(outcome).toEqual({ state });
    expect(h.logs).toEqual([]);
  });

  it('returns the state of the steps that finished, with the failure and its step', async () => {
    const h = contextFor();
    const kept = stateOf({ sentUrls: ['https://example.com/a'] });
    const cause = new DigestError('classify: bad answer', { step: 'classify' });

    const outcome = await settle(h.ctx, () =>
      Promise.reject(new StepFailure('classify', kept, cause)),
    );

    expect(outcome.state).toBe(kept);
    expect(outcome.failure).toEqual({ error: cause, step: 'classify' });
    expect(h.logs).toEqual([]);
  });

  it('starts from nothing and logs when the run failed outside a step', async () => {
    const h = contextFor();
    const error = new Error('Ollama is not reachable');

    const outcome = await settle(h.ctx, () => Promise.reject(error));

    expect(outcome).toEqual({ state: EMPTY_STATE, failure: { error } });
    expect(outcome.failure).not.toHaveProperty('step');
    expect(h.logs).toEqual([
      {
        level: 'error',
        message: 'Run failed outside a step',
        fields: { runId: '2026-W42', error: 'Ollama is not reachable' },
      },
    ]);
  });
});
