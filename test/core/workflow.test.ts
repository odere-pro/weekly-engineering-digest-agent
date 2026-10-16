import { describe, expect, it, vi } from 'vitest';
import { runWorkflow, type WorkflowStep } from '../../src/core/workflow.js';
import { ExitCode } from '../../src/core/schemas.js';
import { DigestError } from '../../src/shared/errors.js';

interface Tally {
  readonly visited: readonly string[];
  readonly total: number;
}

const EMPTY: Tally = { visited: [], total: 0 };

function add(id: string, amount: number): WorkflowStep<Tally> {
  return {
    id,
    run: (state) =>
      Promise.resolve({ visited: [...state.visited, id], total: state.total + amount }),
  };
}

function failing(id: string, error: Error): WorkflowStep<Tally> {
  return { id, run: () => Promise.reject(error) };
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function spyOnConsole() {
  return CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

describe('runWorkflow', () => {
  it('runs the steps in order, feeding each one the output of the previous one', async () => {
    const result = await runWorkflow('tally', [add('a', 1), add('b', 2), add('c', 3)], EMPTY);

    expect(result).toEqual({ visited: ['a', 'b', 'c'], total: 6 });
  });

  it('returns the input unchanged when there are no steps', async () => {
    await expect(runWorkflow('empty', [], EMPTY)).resolves.toBe(EMPTY);
  });

  it('hands state between steps as it is, without serializing it', async () => {
    class Marker {
      readonly at = new Date('2026-10-16T08:00:00Z');
    }
    interface Carried {
      readonly marker: Marker;
      readonly urls: ReadonlySet<string>;
    }
    const input: Carried = { marker: new Marker(), urls: new Set(['https://example.com/a']) };
    const seen: Carried[] = [];
    const record: WorkflowStep<Carried> = {
      id: 'record',
      run: (state) => {
        seen.push(state);
        return Promise.resolve(state);
      },
    };

    const result = await runWorkflow('carry', [record, record], input);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.marker).toBeInstanceOf(Marker);
    expect(seen[1]?.urls).toBeInstanceOf(Set);
    expect(result.marker.at).toBeInstanceOf(Date);
  });

  it('rethrows the very error a step threw, so DigestError keeps its exit code and step', async () => {
    const error = new DigestError('the judge gave no usable score', {
      step: 'select',
      exitCode: ExitCode.Blocked,
    });
    const later = vi.fn((state: Tally) => Promise.resolve(state));

    const run = runWorkflow('fails', [add('a', 1), failing('b', error), { id: 'c', run: later }], {
      ...EMPTY,
    });

    await expect(run).rejects.toBe(error);
    expect(later).not.toHaveBeenCalled();
  });

  it('writes nothing to the console when a step fails', async () => {
    const spies = spyOnConsole();

    await expect(
      runWorkflow('quiet', [failing('boom', new Error('model text must not leak'))], EMPTY),
    ).rejects.toThrow('model text must not leak');

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps concurrent runs apart: each one gets its own result or error', async () => {
    const error = new Error('only the second run fails');

    const [first, second] = await Promise.allSettled([
      runWorkflow('first', [add('a', 1), add('b', 1)], EMPTY),
      runWorkflow('second', [add('a', 1), failing('b', error)], EMPTY),
    ]);

    expect(first).toEqual({ status: 'fulfilled', value: { visited: ['a', 'b'], total: 2 } });
    expect(second).toEqual({ status: 'rejected', reason: error });
  });
});
