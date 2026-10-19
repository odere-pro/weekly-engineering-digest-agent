import { describe, expect, it } from 'vitest';
import { PartialFailure, StepFailure } from './failures';
import { DigestError } from '../../shared/errors';
import { stateOf } from '../__fixtures__/stageKit';

describe('StepFailure', () => {
  it('carries the step, the state it started from and the cause, and says the cause', () => {
    const state = stateOf();
    const cause = new DigestError('boom', { step: 'write' });

    const failure = new StepFailure('write', state, cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ name: 'StepFailure', message: 'boom', step: 'write', state });
    expect(failure.cause).toBe(cause);
  });

  it('names a thrown value that is not an error', () => {
    expect(new StepFailure('collect', stateOf(), 'plain text').message).toBe('plain text');
  });
});

describe('PartialFailure', () => {
  it('carries the state of the partial work and the cause', () => {
    const state = stateOf({ sentUrls: ['https://example.com/a'] });
    const cause = new Error('one channel failed');

    const failure = new PartialFailure(state, cause);

    expect(failure).toMatchObject({ name: 'PartialFailure', message: 'one channel failed', state });
    expect(failure.cause).toBe(cause);
  });
});
