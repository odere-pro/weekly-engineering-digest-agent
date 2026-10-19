import { describe, expect, it } from 'vitest';
import { finish, noteFor } from './finish';
import type { ChainOutcome } from '../chain/state';
import { KEPT_SENT_REASON } from '../ending/keepReason';
import { winnerMessage } from '../ending/shipping/digestMessage';
import { ExitCode } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import { makeRunRecord } from '../../../test/builders';
import type { CapturingDelivery } from '../../../test/fakes';
import {
  WEEK,
  WRITER_A,
  checkedDraft,
  contextFor,
  scored,
  stateOf,
} from '../__fixtures__/stageKit';

const items = [1, 2, 3].map((n) => scored(3, { title: `Runner ${n}.0 ships` }));
const winner = checkedDraft(items, WRITER_A);
const sentOutcome: ChainOutcome = {
  state: stateOf({
    collected: items,
    selected: items,
    winner,
    deliveredTo: ['markdown', 'email'],
    sentUrls: winner.draft.digest.items.map((item) => item.url),
    held: [{ name: 'digest.md', content: winner.markdown }],
  }),
};
const notesOf = (deliveries: readonly unknown[]) =>
  (deliveries as CapturingDelivery[]).map((delivery) => delivery.failures);

describe('finish', () => {
  it('saves the record of a run that was sent, and returns it with the digest and its message', async () => {
    const h = contextFor();

    const result = await finish(h.ctx, sentOutcome, undefined);

    expect(result.record).toMatchObject({ status: 'sent', winner: WRITER_A, runId: WEEK });
    expect(h.store.records.get(WEEK)).toEqual(result.record);
    expect(result.exitCode).toBe(ExitCode.Sent);
    expect(result.markdown).toBe(winner.markdown);
    expect(result.message).toEqual(winnerMessage(h.ctx, winner, false));
    expect(result).not.toHaveProperty('kept');
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe(winner.markdown);
  });

  it('marks a fallback winner in the message it returns', async () => {
    const h = contextFor();
    const outcome = { state: { ...sentOutcome.state, fallback: true } };

    const result = await finish(h.ctx, outcome, undefined);

    expect(result.message).toEqual(winnerMessage(h.ctx, winner, true));
    expect(result.record.fallback).toBe(true);
  });

  it('ends a failed run with the failure in the record, error.json and a note to every channel', async () => {
    const h = contextFor();
    const failure = { error: new DigestError('Ollama is down'), step: 'write' as const };

    const result = await finish(h.ctx, { state: stateOf(), failure }, undefined);

    expect(result.record).toMatchObject({
      status: 'failed',
      error: { message: 'Ollama is down', step: 'write' },
    });
    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.markdown).toBeUndefined();
    expect(result).not.toHaveProperty('message');
    expect(h.store.artifacts.has(`${WEEK}/error.json`)).toBe(true);
    expect(notesOf(h.deliveries)).toEqual([
      [{ weekId: WEEK, step: 'write', message: 'Ollama is down' }],
      [{ weekId: WEEK, step: 'write', message: 'Ollama is down' }],
    ]);
  });

  it('ends a settled quiet week with the note the stage gave, naming the step', async () => {
    const h = contextFor();
    const settled = {
      status: 'quiet' as const,
      note: 'no items collected',
      step: 'collect' as const,
    };

    const result = await finish(h.ctx, { state: stateOf({ settled }) }, undefined);

    expect(result.record.status).toBe('quiet');
    expect(result.exitCode).toBe(ExitCode.Quiet);
    expect(notesOf(h.deliveries)[0]).toEqual([
      { weekId: WEEK, step: 'collect', message: 'no items collected' },
    ]);
  });

  it('sends no note for a quiet week that has no note to give', async () => {
    const h = contextFor();

    await finish(h.ctx, { state: stateOf({ settled: { status: 'quiet' } }) }, undefined);

    expect(notesOf(h.deliveries)).toEqual([[], []]);
  });

  describe('when the week earlier record reached a channel', () => {
    const earlier = makeRunRecord({ runId: WEEK, status: 'sent' });

    it('keeps it, says why, writes no held file and names no digest path', async () => {
      const h = contextFor({ holdArtifacts: true });
      h.store.records.set(WEEK, earlier);
      const outcome = { state: { ...sentOutcome.state, deliveredTo: [] } };
      const forcedFailure = { ...outcome, failure: { error: new Error('boom') } };

      const result = await finish(h.ctx, forcedFailure, earlier);

      expect(result.kept).toBe(KEPT_SENT_REASON);
      expect(result.markdown).toBeUndefined();
      expect(h.store.records.get(WEEK)).toBe(earlier);
      expect(h.store.artifacts.has(`${WEEK}/digest.md`)).toBe(false);
    });

    it('names the digest path again once the run replaced the record and wrote digest.md', async () => {
      const h = contextFor({ holdArtifacts: true });
      h.store.records.set(WEEK, earlier);

      const result = await finish(h.ctx, sentOutcome, earlier);

      expect(result.kept).toBeUndefined();
      expect(result.markdown).toBe(winner.markdown);
      expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe(winner.markdown);
    });
  });
});

describe('noteFor', () => {
  const { ctx } = contextFor();

  it('is the note of the failure when the chain failed', () => {
    const failure = { error: new Error('classify: bad answer'), step: 'classify' as const };

    expect(noteFor(ctx, { state: stateOf(), failure })).toEqual({
      weekId: WEEK,
      step: 'classify',
      message: 'classify: bad answer',
    });
  });

  it('is the note a stage settled the run with, under the step that settled it', () => {
    const state = stateOf({
      settled: { status: 'blocked', note: 'every draft was rejected', step: 'guardOutput' },
    });

    expect(noteFor(ctx, { state })).toEqual({
      weekId: WEEK,
      step: 'guardOutput',
      message: 'every draft was rejected',
    });
  });

  it('is nothing for a run that went through, or a quiet week with no note', () => {
    expect(noteFor(ctx, { state: stateOf() })).toBeUndefined();
    expect(noteFor(ctx, { state: stateOf({ settled: { status: 'quiet' } }) })).toBeUndefined();
  });
});
