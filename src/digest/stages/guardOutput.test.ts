import { describe, expect, it } from 'vitest';
import { guardOutput } from './guardOutput';
import { FALLBACK_WRITER } from '../../write/fallbackDigest';
import type { CodeChecked } from '../../write/checkedStep/types';
import type { Draft, Item } from '../../domain/schemas';
import type { GuardCallOptions, OutputGuard } from '../../guards/Guard';
import type { GuardVerdict } from '../../guards/guardVerdict';
import { FakeOutputGuard } from '../../../test/fakes';
import {
  WRITER_A,
  WRITER_B,
  checkedDraft,
  contextFor,
  scored,
  stateOf,
} from '../__fixtures__/stageKit';

const selected = [1, 2, 3, 4].map((n) =>
  scored(3, { title: `Runner ${n}.0 ships`, summary: `Runner ${n}.0 is faster. It also caches.` }),
);

const checked = (writer: string, rejectedBy: string[] = []): CodeChecked => ({
  ...checkedDraft(selected, writer),
  rejectedBy,
  problems: rejectedBy,
});

const flagWriter =
  (writer: string) =>
  (draft: Draft): boolean =>
    draft.writer === writer;

function guards(flag?: (draft: Draft) => boolean) {
  return [new FakeOutputGuard('graniteGroundedness', flag), new FakeOutputGuard('clefRubric')];
}

const stateWith = (...entries: CodeChecked[]) =>
  stateOf({ selected, collected: selected, checked: entries });

describe('guardOutput', () => {
  it('passes the drafts the guards do not flag, and records each writer as passed in profile order', async () => {
    const h = contextFor({ outputGuards: guards() });

    const next = await guardOutput(
      h.ctx,
      stateWith(checked(WRITER_B), checked(WRITER_A)),
      h.logger,
    );

    expect(next.passed.map((entry) => entry.draft.writer)).toEqual([WRITER_B, WRITER_A]);
    expect(next.drafts).toEqual([
      { writer: WRITER_A, passed: true, rejectedBy: [] },
      { writer: WRITER_B, passed: true, rejectedBy: [] },
    ]);
    expect(next.settled).toBeUndefined();
  });

  it('shows the guards only the drafts that passed the link and format checks', async () => {
    const outputGuards = guards();
    const h = contextFor({ outputGuards });

    await guardOutput(
      h.ctx,
      stateWith(checked(WRITER_A), checked(WRITER_B, ['linkCheck'])),
      h.logger,
    );

    for (const guard of outputGuards) {
      expect(guard.calls.map((draft) => draft.writer)).toEqual([WRITER_A]);
    }
  });

  it('records a draft the checks rejected with the checks, and one a guard flagged with the guard', async () => {
    const h = contextFor({ outputGuards: guards(flagWriter(WRITER_A)) });
    const state = stateWith(
      checked(WRITER_A),
      checked(WRITER_B, ['linkCheck']),
      checked('writer-c:9b'),
    );

    const next = await guardOutput(h.ctx, state, h.logger);

    expect(next.drafts).toEqual([
      { writer: WRITER_A, passed: false, rejectedBy: ['graniteGroundedness'] },
      { writer: WRITER_B, passed: false, rejectedBy: ['linkCheck'] },
      { writer: 'writer-c:9b', passed: true, rejectedBy: [] },
    ]);
    expect(next.passed.map((entry) => entry.draft.writer)).toEqual(['writer-c:9b']);
  });

  it('keeps the outcomes of writers that failed before, in profile order', async () => {
    const h = contextFor({ outputGuards: guards() });
    const state = {
      ...stateWith(checked(WRITER_B)),
      drafts: [{ writer: WRITER_A, passed: false, rejectedBy: ['write'] }],
    };

    const next = await guardOutput(h.ctx, state, h.logger);

    expect(next.drafts.map((outcome) => [outcome.writer, outcome.passed])).toEqual([
      [WRITER_A, false],
      [WRITER_B, true],
    ]);
  });

  describe('when no draft is left', () => {
    const allRejected = () =>
      stateWith(checked(WRITER_A, ['linkCheck']), checked(WRITER_B, ['formatCheck']));

    it('puts the template-only fallback in their place', async () => {
      const h = contextFor({ outputGuards: guards() });

      const next = await guardOutput(h.ctx, allRejected(), h.logger);

      expect(next.fallback).toBe(true);
      expect(next.settled).toBeUndefined();
      expect(next.passed.map((entry) => entry.draft.writer)).toEqual([FALLBACK_WRITER]);
      expect(next.drafts.map((outcome) => outcome.writer)).toEqual([
        WRITER_A,
        WRITER_B,
        FALLBACK_WRITER,
      ]);
    });

    it('settles the run as blocked, naming each writer and its checks, when the fallback is off', async () => {
      const h = contextFor({ outputGuards: guards(), useFallback: false });

      const next = await guardOutput(h.ctx, allRejected(), h.logger);

      expect(next.passed).toEqual([]);
      expect(next.fallback).toBeUndefined();
      expect(next.settled).toEqual({
        status: 'blocked',
        note: `every draft was rejected: ${WRITER_A} (linkCheck); ${WRITER_B} (formatCheck)`,
      });
    });

    it('settles the run as blocked when the guards flag every draft and the fallback is off', async () => {
      const h = contextFor({
        outputGuards: guards(() => true),
        useFallback: false,
      });

      const next = await guardOutput(h.ctx, stateWith(checked(WRITER_A)), h.logger);

      expect(next.settled?.note).toBe(
        `every draft was rejected: ${WRITER_A} (graniteGroundedness)`,
      );
    });
  });
});

describe('guardOutput when the run is told to stop', () => {
  /** Remembers the options of each call; flags the first draft it sees when told to. */
  class SignalGuard implements OutputGuard {
    readonly options: (GuardCallOptions | undefined)[] = [];
    readonly id = 'graniteGroundedness' as const;
    constructor(private readonly flagFirst = false) {}
    checkDraft(
      _draft: Draft,
      _sources: readonly Item[],
      options?: GuardCallOptions,
    ): Promise<GuardVerdict> {
      this.options.push(options);
      return Promise.resolve({
        check: this.id,
        flagged: this.flagFirst && this.options.length === 1,
      });
    }
  }

  it('hands the run signal to the guards', async () => {
    const controller = new AbortController();
    const guard = new SignalGuard();
    const h = contextFor({ outputGuards: [guard], signal: controller.signal });

    await guardOutput(h.ctx, stateWith(checked(WRITER_A), checked(WRITER_B)), h.logger);

    expect(guard.options).toHaveLength(2);
    expect(guard.options.every((options) => options?.signal === controller.signal)).toBe(true);
  });

  it('hands it to the fallback digest check too', async () => {
    const controller = new AbortController();
    const guard = new SignalGuard(true);
    const h = contextFor({ outputGuards: [guard], signal: controller.signal });

    const next = await guardOutput(h.ctx, stateWith(checked(WRITER_A)), h.logger);

    expect(next.fallback).toBe(true);
    expect(guard.options).toHaveLength(2);
    expect(guard.options.every((options) => options?.signal === controller.signal)).toBe(true);
  });

  it('fails with the reason and calls no guard when the signal fired already', async () => {
    const controller = new AbortController();
    const reason = new Error('run timed out');
    controller.abort(reason);
    const guard = new SignalGuard();
    const h = contextFor({ outputGuards: [guard], signal: controller.signal });

    await expect(guardOutput(h.ctx, stateWith(checked(WRITER_A)), h.logger)).rejects.toBe(reason);

    expect(guard.options).toEqual([]);
  });
});
