import { describe, expect, it } from 'vitest';
import { blocked, inWriterOrder, rejected } from './draftOutcomes';
import type { DraftOutcome } from '../../store/runRecord';
import { WRITER_A, WRITER_B, contextFor } from '../__fixtures__/stageKit';

const passed = (writer: string): DraftOutcome => ({ writer, passed: true, rejectedBy: [] });

describe('rejected', () => {
  it('records a draft that did not pass, with a copy of the checks that rejected it', () => {
    const checks = ['linkCheck', 'formatCheck'];

    const outcome = rejected(WRITER_A, checks);
    checks.push('later');

    expect(outcome).toEqual({
      writer: WRITER_A,
      passed: false,
      rejectedBy: ['linkCheck', 'formatCheck'],
    });
  });
});

describe('inWriterOrder', () => {
  it('puts the outcomes in the order of the profile writers', () => {
    const { ctx } = contextFor();

    const ordered = inWriterOrder(ctx, [passed(WRITER_B), rejected(WRITER_A, ['write'])]);

    expect(ordered.map((outcome) => outcome.writer)).toEqual([WRITER_A, WRITER_B]);
  });

  it('puts a writer the profile does not list last, and keeps equal ranks in the order given', () => {
    const { ctx } = contextFor();

    const ordered = inWriterOrder(ctx, [
      passed('template-only'),
      passed('other-extra'),
      passed(WRITER_B),
    ]);

    expect(ordered.map((outcome) => outcome.writer)).toEqual([
      WRITER_B,
      'template-only',
      'other-extra',
    ]);
  });

  it('does not change the list it was given', () => {
    const { ctx } = contextFor();
    const given = [passed(WRITER_B), passed(WRITER_A)];

    inWriterOrder(ctx, given);

    expect(given.map((outcome) => outcome.writer)).toEqual([WRITER_B, WRITER_A]);
  });
});

describe('blocked', () => {
  it('settles the run as blocked, naming each writer and the checks that rejected it', () => {
    const settled = blocked([
      rejected(WRITER_A, ['linkCheck']),
      rejected(WRITER_B, ['graniteGroundedness', 'clefRubric']),
    ]);

    expect(settled).toEqual({
      status: 'blocked',
      note: `every draft was rejected: ${WRITER_A} (linkCheck); ${WRITER_B} (graniteGroundedness, clefRubric)`,
    });
  });

  it('has nothing to name when no writer made a draft', () => {
    expect(blocked([])).toEqual({ status: 'blocked', note: 'every draft was rejected' });
  });
});
