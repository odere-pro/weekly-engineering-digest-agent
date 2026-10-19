import { describe, expect, it } from 'vitest';
import { abortedDuring, abortedError, isUnretriable, needsForce } from './unretriable';
import { DigestError } from '../../../shared/errors';

describe('abortedError', () => {
  it('is nothing for no signal or a signal that has not fired', () => {
    expect(abortedError(undefined, 'write')).toBeUndefined();
    expect(abortedError(new AbortController().signal, 'write')).toBeUndefined();
  });

  it('names the step the run was about to start and the reason', () => {
    const controller = new AbortController();
    controller.abort(new Error('scheduler timeout after 2h'));

    const error = abortedError(controller.signal, 'write');

    expect(error).toBeInstanceOf(DigestError);
    expect(error?.message).toBe('Run aborted before the write step: scheduler timeout after 2h');
    expect(error?.step).toBe('write');
    expect(error?.cause).toBe(controller.signal.reason);
  });

  it('leaves the step out when the run had not started one', () => {
    const controller = new AbortController();
    controller.abort('shutting down');

    const error = abortedError(controller.signal);

    expect(error?.message).toBe('Run aborted: shutting down');
    expect(error?.step).toBeUndefined();
  });

  it('exits like any failed run', () => {
    const controller = new AbortController();
    controller.abort();

    expect(abortedError(controller.signal)?.exitCode).toBe(1);
  });
});

describe('abortedDuring', () => {
  it('is nothing for no signal or a signal that has not fired', () => {
    expect(abortedDuring(undefined, 'collect')).toBeUndefined();
    expect(abortedDuring(new AbortController().signal, 'collect')).toBeUndefined();
  });

  it('names the step the run was in and the reason', () => {
    const controller = new AbortController();
    controller.abort(new Error('scheduler timeout after 2h'));

    const error = abortedDuring(controller.signal, 'collect');

    expect(error).toBeInstanceOf(DigestError);
    expect(error?.message).toBe('Run aborted during the collect step: scheduler timeout after 2h');
    expect(error?.step).toBe('collect');
    expect(error?.cause).toBe(controller.signal.reason);
    expect(error?.exitCode).toBe(1);
  });

  it('writes a message that isUnretriable knows, so no retry follows it', () => {
    const controller = new AbortController();
    controller.abort('shutting down');

    expect(isUnretriable(abortedDuring(controller.signal, 'guardInput')?.message)).toBe(true);
  });
});

describe('needsForce', () => {
  it('knows the error of a resume that a person has to clear', () => {
    expect(needsForce('digest.md is gone; run with --force to send a new digest')).toBe(true);
  });

  it.each([
    ['an ordinary failure', 'Ollama is not reachable'],
    ['nothing', undefined],
    ['an empty message', ''],
  ])('does not take %s for one', (_name, message) => {
    expect(needsForce(message)).toBe(false);
  });
});

describe('isUnretriable', () => {
  it.each([
    [
      'a run told to stop before a step',
      'Run aborted before the write step: run timed out after 3 h',
    ],
    ['a run told to stop before the chain', 'Run aborted: the service was asked to stop again'],
    [
      'a resume that only --force can clear',
      'digest.md is gone; run with --force to send a new one',
    ],
  ])('knows %s', (_name, message) => {
    expect(isUnretriable(message)).toBe(true);
  });

  it('knows the message abortedError writes', () => {
    const controller = new AbortController();
    controller.abort(new Error('run timed out after 3 h'));

    expect(isUnretriable(abortedError(controller.signal, 'collect')?.message)).toBe(true);
    expect(isUnretriable(abortedError(controller.signal)?.message)).toBe(true);
  });

  it.each([
    ['an ordinary failure', 'Ollama is not reachable'],
    ['a message that only mentions aborting', 'The request was aborted by the server'],
    ['nothing', undefined],
  ])('does not take %s for one', (_name, message) => {
    expect(isUnretriable(message)).toBe(false);
  });
});
