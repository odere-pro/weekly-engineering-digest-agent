import { describe, expect, it } from 'vitest';
import { failureNote, sendFailureNote, sendOrHoldNote } from './failureNotes';
import { abortedError } from './unretriable';
import { DigestError } from '../../../shared/errors';
import { WEEK, setupEnding } from '../__fixtures__/endingKit';

const HELD_BACK = 'Failure note held back: notifyFailure is off for this run';
const failure = { error: new DigestError('Ollama is not reachable'), step: 'write' as const };
const note = failureNote(WEEK, failure);
const notesOf = (h: ReturnType<typeof setupEnding>) => h.deliveries.map((d) => d.failures);

describe('failureNote', () => {
  it('names the week, the step and the message of the failure', () => {
    expect(note).toEqual({ weekId: WEEK, step: 'write', message: 'Ollama is not reachable' });
  });

  it('has no step for a failure outside a step', () => {
    expect(failureNote(WEEK, { error: 'boom' })).toEqual({
      weekId: WEEK,
      step: undefined,
      message: 'boom',
    });
  });
});

describe('sendFailureNote', () => {
  it('sends the note to every channel', async () => {
    const h = setupEnding();

    await sendFailureNote(h.ctx, note);

    expect(notesOf(h)).toEqual([[note], [note]]);
  });

  it('sends nothing in a dry run', async () => {
    const h = setupEnding({ dryRun: true });

    await sendFailureNote(h.ctx, note);

    expect(notesOf(h)).toEqual([[], []]);
  });

  it('logs the channel that refuses it and still tells the others', async () => {
    const h = setupEnding();
    h.deliveries[0]!.sendFailure = () => Promise.reject(new Error('webhook 500'));

    await sendFailureNote(h.ctx, note);

    expect(h.deliveries[1]?.failures).toEqual([note]);
    expect(h.logs).toEqual([
      {
        level: 'error',
        message: 'Could not send the failure note',
        fields: { delivery: 'markdown', error: 'webhook 500' },
      },
    ]);
  });
});

describe('sendOrHoldNote', () => {
  it('sends the note when notifyFailure is left out', async () => {
    const h = setupEnding();

    await sendOrHoldNote(h.ctx, note, failure);

    expect(notesOf(h)).toEqual([[note], [note]]);
  });

  it('holds the note of a failure a retry can clear, and logs the step', async () => {
    const h = setupEnding({ notifyFailure: false });

    await sendOrHoldNote(h.ctx, note, failure);

    expect(notesOf(h)).toEqual([[], []]);
    expect(h.logs).toEqual([{ level: 'info', message: HELD_BACK, fields: { step: 'write' } }]);
  });

  it('sends the note of a failure no retry can clear, even when notifyFailure is false', async () => {
    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    const stopped = { error: abortedError(controller.signal, 'write'), step: 'write' as const };
    const h = setupEnding({ notifyFailure: false });

    await sendOrHoldNote(h.ctx, failureNote(WEEK, stopped), stopped);

    expect(notesOf(h).map((sent) => sent.length)).toEqual([1, 1]);
    expect(h.logs).toEqual([]);
  });

  it('sends the note of a run that did not fail, even when notifyFailure is false', async () => {
    const h = setupEnding({ notifyFailure: false });
    const blockedNote = { weekId: WEEK, message: 'every draft was rejected' };

    await sendOrHoldNote(h.ctx, blockedNote, undefined);

    expect(notesOf(h)).toEqual([[blockedNote], [blockedNote]]);
  });

  it('does nothing without a note, or in a dry run', async () => {
    const h = setupEnding({ notifyFailure: false });
    const dry = setupEnding({ dryRun: true });

    await sendOrHoldNote(h.ctx, undefined, undefined);
    await sendOrHoldNote(dry.ctx, note, failure);

    expect(notesOf(h)).toEqual([[], []]);
    expect(notesOf(dry)).toEqual([[], []]);
    expect(h.logs).toEqual([]);
    expect(dry.logs).toEqual([]);
  });
});
