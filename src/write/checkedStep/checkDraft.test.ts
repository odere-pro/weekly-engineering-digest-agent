import { describe, expect, it, vi } from 'vitest';
import type { Draft } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { checkDraft } from './checkDraft';
import type { CheckContext } from './types';
import { makeDigest, makeDigestItem, makeItem } from '../../../test/builders';
import { noopLogger } from '../../../test/fakes';

const DOCKER_URL = 'https://www.docker.com/blog/spec/';
const DOCKER_LINK = 'www.docker.com/blog/spec/';
const EM_DASH = '—';

const items = [makeItem({ url: DOCKER_URL }), makeItem(), makeItem(), makeItem()];

function spyLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const logger: Logger = { ...noopLogger, info, child: () => logger };
  return { logger, info };
}

const contextOf = (overrides: Partial<CheckContext> = {}): CheckContext => ({
  collected: items,
  disabledGuards: [],
  topN: 5,
  logger: noopLogger,
  ...overrides,
});

/** A draft over the first three items, with `summary` on the first one. */
function draftWithSummary(summary: string, writer = 'writer-a'): Draft {
  const digest = makeDigest(items.slice(0, 3));
  const [first, ...rest] = digest.items;
  return { writer, digest: { ...digest, items: [{ ...first!, summary }, ...rest] } };
}

describe('checkDraft', () => {
  it('passes a clean draft', () => {
    const result = checkDraft(draftWithSummary('Docker proposes a spec.'), contextOf());

    expect(result.rejectedBy).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('gives a bare link its scheme before the link check, so the draft passes', () => {
    const result = checkDraft(draftWithSummary(`Read ${DOCKER_LINK} today.`), contextOf());

    expect(result.rejectedBy).toEqual([]);
    expect(result.draft.digest.items[0]?.summary).toBe(`Read ${DOCKER_URL} today.`);
    expect(result.markdown).toContain(`Read ${DOCKER_URL} today.`);
  });

  it('removes em dashes before the format check', () => {
    const result = checkDraft(draftWithSummary(`Fast ${EM_DASH} faster`), contextOf());

    expect(result.rejectedBy).toEqual([]);
    expect(result.draft.digest.items[0]?.summary).toBe('Fast, faster');
  });

  it('keeps at most topN items', () => {
    const digest = makeDigest(items);

    const result = checkDraft({ writer: 'w', digest }, contextOf({ topN: 3 }));

    expect(result.draft.digest.items).toHaveLength(3);
  });

  it('rejects a link that is not a collected url, and leaves it in the draft for the retry', () => {
    const result = checkDraft(draftWithSummary('Read //evil.example/payload today.'), contextOf());

    expect(result.rejectedBy).toEqual(['linkCheck']);
    expect(result.problems.join('\n')).toContain('//evil.example/payload');
  });

  it('logs how many links it fixed, for the writer, and nothing when there were none', () => {
    const { logger, info } = spyLogger();

    checkDraft(
      draftWithSummary(`Read ${DOCKER_LINK} and //${DOCKER_LINK}.`, 'writer-b'),
      contextOf({ logger }),
    );
    checkDraft(draftWithSummary('Nothing to fix.'), contextOf({ logger }));

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Added https:// to links the writer left bare', {
      writer: 'writer-b',
      links: 2,
    });
  });

  it('renders the footer for a disabled guard into the checked Markdown', () => {
    const open = checkDraft(draftWithSummary('Plain.'), contextOf());
    const off = checkDraft(
      draftWithSummary('Plain.'),
      contextOf({ disabledGuards: ['clefRubric'] }),
    );

    expect(off.markdown).not.toBe(open.markdown);
  });

  it('does not change the draft it was given', () => {
    const draft = draftWithSummary(`Read ${DOCKER_LINK} ${EM_DASH} now`);
    const snapshot = structuredClone(draft);

    const result = checkDraft(draft, contextOf());

    expect(draft).toEqual(snapshot);
    expect(result.draft).not.toBe(draft);
  });

  it('does not touch an item the writer wrote with an action', () => {
    const digest = makeDigest(items.slice(0, 3), {
      items: items
        .slice(0, 3)
        .map((item) =>
          makeDigestItem(item, { urgency: 'worth-a-look', action: 'Relevant if you run it.' }),
        ),
    });

    const result = checkDraft({ writer: 'w', digest }, contextOf());

    expect(result.rejectedBy).toEqual([]);
    expect(result.draft.digest.items.map((item) => item.action)).toEqual([
      'Relevant if you run it.',
      'Relevant if you run it.',
      'Relevant if you run it.',
    ]);
  });
});
