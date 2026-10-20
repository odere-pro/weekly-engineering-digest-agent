import { describe, expect, it } from 'vitest';
import { buildRecord, statusOf } from './buildRecord';
import { EMPTY_STATE } from '../chain/state';
import { modelsByRole } from '../../config/profiles';
import { DigestError } from '../../shared/errors';
import { RunRecordSchema } from '../../store/runRecord';
import {
  NOW,
  PROFILE,
  WEEK,
  WRITER_A,
  checkedDraft,
  contextFor,
  scored,
  stateOf,
} from '../__fixtures__/stageKit';

const FINISHED = new Date('2026-10-16T08:05:00Z');
const items = [1, 2, 3].map((n) => scored(3, { title: `Runner ${n}.0 ships` }));
const winner = checkedDraft(items, WRITER_A);

describe('statusOf', () => {
  const { ctx } = contextFor();

  it('is failed whenever the chain failed, whatever the state says', () => {
    const outcome = {
      state: stateOf({ settled: { status: 'quiet' } }),
      failure: { error: new Error('boom'), step: 'write' as const },
    };

    expect(statusOf(ctx, outcome)).toBe('failed');
  });

  it.each(['quiet', 'blocked'] as const)('is %s when a stage settled the run so', (status) => {
    expect(statusOf(ctx, { state: stateOf({ settled: { status } }) })).toBe(status);
  });

  it('is sent for a run that went through, and dry-run for a dry run', () => {
    expect(statusOf(ctx, { state: EMPTY_STATE })).toBe('sent');
    expect(statusOf(contextFor({ dryRun: true }).ctx, { state: EMPTY_STATE })).toBe('dry-run');
  });
});

describe('buildRecord', () => {
  it('describes a run that produced nothing: zero counts, no winner, no optional keys', () => {
    const { ctx } = contextFor();

    const record = buildRecord(ctx, { state: EMPTY_STATE }, 'quiet', FINISHED);

    expect(record).toEqual({
      runId: WEEK,
      status: 'quiet',
      dryRun: false,
      startedAt: new Date(NOW).toISOString(),
      finishedAt: FINISHED.toISOString(),
      profile: 'quality',
      modelsByRole: modelsByRole(PROFILE),
      timings: [],
      counts: {
        collected: 0,
        afterGuardInput: 0,
        classified: 0,
        selected: 0,
        guardedCandidates: 0,
        digestItems: 0,
      },
      failedSources: [],
      disabledGuards: [],
      drafts: [],
      winner: null,
      sentUrls: [],
    });
    expect(RunRecordSchema.parse(record)).toEqual(record);
  });

  it('counts what each stage produced, and the digest items of the winner', () => {
    const { ctx } = contextFor();
    const state = stateOf({
      collected: items,
      kept: items.slice(0, 2),
      scored: items,
      afterProcess: 3,
      selected: items,
      winner,
      drafts: [{ writer: WRITER_A, passed: true, rejectedBy: [] }],
      sentUrls: ['https://example.com/a'],
      timings: [{ step: 'collect', ms: 12 }],
      failedSources: [{ sourceId: 'feed', error: 'timed out' }],
    });

    const record = buildRecord(ctx, { state }, 'sent', FINISHED);

    expect(record.counts).toEqual({
      collected: 3,
      afterGuardInput: 2,
      classified: 3,
      afterProcess: 3,
      selected: 3,
      guardedCandidates: 0,
      digestItems: 3,
    });
    expect(record).toMatchObject({
      winner: WRITER_A,
      drafts: [{ writer: WRITER_A, passed: true, rejectedBy: [] }],
      sentUrls: ['https://example.com/a'],
      timings: [{ step: 'collect', ms: 12 }],
      failedSources: [{ sourceId: 'feed', error: 'timed out' }],
    });
    expect(RunRecordSchema.parse(record)).toEqual(record);
  });

  it('counts the items the model guards checked after process, 0 when that step never ran', () => {
    const { ctx } = contextFor();

    const ran = buildRecord(ctx, { state: stateOf({ guardedCandidates: 7 }) }, 'sent', FINISHED);
    const quiet = buildRecord(ctx, { state: EMPTY_STATE }, 'quiet', FINISHED);

    expect(ran.counts.guardedCandidates).toBe(7);
    expect(quiet.counts.guardedCandidates).toBe(0);
  });

  it('leaves guardedCandidates out when the model guards ran before classify (rescoreWithWriter)', () => {
    const { ctx } = contextFor({ config: { models: { rescoreWithWriter: true } } });

    const record = buildRecord(ctx, { state: EMPTY_STATE }, 'quiet', FINISHED);

    expect(record.counts).not.toHaveProperty('guardedCandidates');
  });

  it('leaves afterProcess out until the process step ran', () => {
    const record = buildRecord(contextFor().ctx, { state: EMPTY_STATE }, 'failed', FINISHED);

    expect(record.counts).not.toHaveProperty('afterProcess');
  });

  it('records the dry run, the guards that were off and the sampling it was given', () => {
    const sampling = { seed: 7, temperatureByRole: { write: 0.7 } };
    const { ctx } = contextFor({ dryRun: true, disabledGuards: ['clefPolicy'], sampling });

    const record = buildRecord(ctx, { state: EMPTY_STATE }, 'dry-run', FINISHED);

    expect(record).toMatchObject({ dryRun: true, disabledGuards: ['clefPolicy'], sampling });
  });

  it('flags a fallback win and lists the channels that took the digest', () => {
    const { ctx } = contextFor();
    const state = stateOf({ fallback: true, deliveredTo: ['markdown', 'email'] });

    const record = buildRecord(ctx, { state }, 'sent', FINISHED);

    expect(record.fallback).toBe(true);
    expect(record.deliveredTo).toEqual(['markdown', 'email']);
  });

  it('records the failure: its message and step, never the stack', () => {
    const { ctx } = contextFor();
    const failure = { error: new DigestError('Ollama is down'), step: 'collect' as const };

    const record = buildRecord(ctx, { state: EMPTY_STATE, failure }, 'failed', FINISHED);

    expect(record.error).toEqual({ message: 'Ollama is down', step: 'collect' });
  });

  it('copies the lists, so a later change to the state cannot reach the record', () => {
    const { ctx } = contextFor();
    const state = stateOf({ sentUrls: ['https://example.com/a'] });

    const record = buildRecord(ctx, { state }, 'sent', FINISHED);

    expect(record.sentUrls).not.toBe(state.sentUrls);
    expect(record.timings).not.toBe(state.timings);
    expect(record.drafts).not.toBe(state.drafts);
  });
});
