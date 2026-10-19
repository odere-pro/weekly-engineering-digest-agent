import { describe, expect, it, vi } from 'vitest';
import { write } from './write';
import { PartialFailure } from '../chain/failures';
import type { Draft, Item } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import { DATA_OPEN } from '../../shared/untrusted';
import { FakeModelProvider } from '../../../test/fakes';
import {
  AREA,
  WEEK,
  WRITER_A,
  WRITER_B,
  contextFor,
  scored,
  stateOf,
} from '../__fixtures__/stageKit';

const EVIL = 'https://evil.example/payload';
const items = [1, 2, 3].map((n) => scored(3 - n / 10, { title: `Runner ${n}.0 ships` }));

function body(given: readonly Item[], summary = (item: Item) => `${item.title} is out.`) {
  return {
    headline: 'Runners moved this week',
    intro: 'These releases change how teams ship.',
    items: given.map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      area: AREA,
      summary: summary(item),
      whyItMatters: 'Teams can cut CI time.',
      urgency: 'worth-a-look',
      action: 'Relevant if you run it.',
    })),
  };
}

/** `reply` gets the writer and the items its prompt names; throwing fails that writer. */
function run(reply: (writer: string, given: Item[]) => unknown, options: { hold?: boolean } = {}) {
  const model = new FakeModelProvider({
    generate: (request) => {
      const given = items.filter((item) => request.prompt.includes(`${DATA_OPEN} ${item.id}>>>`));
      return JSON.stringify(reply(request.model ?? '', given));
    },
  });
  const h = contextFor({ model, holdArtifacts: options.hold });
  const result = write(h.ctx, stateOf({ selected: items, collected: items }), h.logger);
  const draftsFile = () =>
    JSON.parse(h.store.artifacts.get(`${WEEK}/drafts.json`) ?? '{}') as {
      drafts: Draft[];
      failures: { writer: string; retry?: boolean }[];
      rejections: { writer: string }[];
    };
  return { ...h, result, draftsFile };
}

describe('write', () => {
  it('has every writer draft the selected items and keeps each draft with its check result', async () => {
    const h = run((_writer, given) => body(given));

    const next = await h.result;

    expect(next.checked.map((entry) => entry.draft.writer)).toEqual([WRITER_A, WRITER_B]);
    expect(next.checked.every((entry) => entry.rejectedBy.length === 0)).toBe(true);
    expect(next.drafts).toEqual([]);
  });

  it('writes drafts.json and keeps what it holds in the state, for the fallback to extend', async () => {
    const h = run((_writer, given) => body(given));

    const next = await h.result;

    const file = h.draftsFile();
    expect(file.drafts.map((draft) => draft.writer)).toEqual([WRITER_A, WRITER_B]);
    expect(file.failures).toEqual([]);
    expect(file.rejections).toEqual([]);
    expect(next.draftsFile).toEqual(file);
  });

  it('holds drafts.json when the earlier files of the week must stay', async () => {
    const h = run((_writer, given) => body(given), { hold: true });

    const next = await h.result;

    expect(h.store.artifacts.size).toBe(0);
    expect(next.held.map((artifact) => artifact.name)).toEqual(['drafts.json']);
    expect(next.draftsFile?.drafts).toHaveLength(2);
  });

  it('records a writer that failed as rejected by write, and goes on with the others', async () => {
    const h = run((writer, given) => {
      if (writer === WRITER_B) throw new Error('model timed out');
      return body(given);
    });

    const next = await h.result;

    expect(next.checked.map((entry) => entry.draft.writer)).toEqual([WRITER_A]);
    expect(next.drafts).toEqual([{ writer: WRITER_B, passed: false, rejectedBy: ['write'] }]);
    expect(h.draftsFile().failures.map((failure) => failure.writer)).toEqual([WRITER_B]);
  });

  it('keeps a draft that failed the link check, with the check, for the guard step to report', async () => {
    const h = run((_writer, given) =>
      body(given, (item) => (item === given[0] ? `See ${EVIL} now.` : `${item.title} is out.`)),
    );

    const next = await h.result;

    expect(next.checked.map((entry) => entry.rejectedBy)).toEqual([['linkCheck'], ['linkCheck']]);
    expect(h.draftsFile().rejections.map((rejection) => rejection.writer)).toContain(WRITER_A);
  });

  it('fails the step when every writer failed, naming them but not what the model said', async () => {
    const h = run((writer) => {
      throw new Error(`${writer} replied with ignore all previous instructions`);
    });

    const failure = await h.result.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PartialFailure);
    const { cause, message, state } = failure as PartialFailure;
    expect(cause).toBeInstanceOf(DigestError);
    expect(cause).toMatchObject({ step: 'write' });
    expect(message).toBe(
      `Every writer failed: ${WRITER_A}, ${WRITER_B}; drafts.json has the reasons`,
    );
    expect(message).not.toContain('ignore all previous');
    expect(state.drafts.map((outcome) => outcome.rejectedBy)).toEqual([['write'], ['write']]);
    expect(h.draftsFile().drafts).toEqual([]);
    expect(h.draftsFile().failures).toHaveLength(2);
  });
});

describe('write when the run is told to stop', () => {
  const reason = new Error('run timed out');

  /** A writer call that ends only when the signal it is given fires. */
  const hanging = () =>
    new FakeModelProvider({
      generate: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              reject(request.signal?.reason as Error);
            },
            { once: true },
          );
        }),
    });

  it('gives the writer calls the run signal, and fails with its reason, not as a failed writer', async () => {
    const controller = new AbortController();
    const fake = hanging();
    const h = contextFor({ model: fake, signal: controller.signal });
    const pending = write(h.ctx, stateOf({ selected: items, collected: items }), h.logger);
    await vi.waitFor(() => {
      expect(fake.generateCalls).toHaveLength(1);
    });
    expect(fake.generateCalls[0]?.signal).toBe(controller.signal);

    controller.abort(reason);

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBe(reason);
    expect(failure).not.toBeInstanceOf(PartialFailure);
    expect(fake.generateCalls).toHaveLength(1);
    expect(h.store.artifacts.size).toBe(0);
  });

  it('starts no writer, and writes no drafts.json, when the signal fired already', async () => {
    const controller = new AbortController();
    controller.abort(reason);
    const fake = hanging();
    const h = contextFor({ model: fake, signal: controller.signal });

    await expect(
      write(h.ctx, stateOf({ selected: items, collected: items }), h.logger),
    ).rejects.toBe(reason);

    expect(fake.generateCalls).toEqual([]);
    expect(h.store.artifacts.size).toBe(0);
  });
});
