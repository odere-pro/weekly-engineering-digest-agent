import { describe, expect, it } from 'vitest';
import { winnerMessage } from './digestMessage';
import { buildDigestView, FALLBACK_NOTE } from '../../../render/layout';
import { renderAppendix } from '../../../render/appendix';
import { makeDraft, makeItem, makeScoredItem } from '../../../../test/builders';
import { WEEK } from '../__fixtures__/endingKit';

const draft = makeDraft([makeItem(), makeItem()], 'writer-a');
const winner = { draft, markdown: '# The winning digest\n' };

describe('winnerMessage', () => {
  it('names the week and headline, carries the winner Markdown and the laid-out view', () => {
    const message = winnerMessage({ weekId: WEEK, disabledGuards: [] }, winner, false);

    expect(message).toEqual({
      weekId: WEEK,
      subject: `Engineering digest ${WEEK}: ${draft.digest.headline}`,
      markdown: winner.markdown,
      view: buildDigestView(draft.digest, { disabledGuards: [], fallback: false }),
    });
  });

  it('puts the guards that were off into the view footer', () => {
    const message = winnerMessage({ weekId: WEEK, disabledGuards: ['clefPolicy'] }, winner, false);

    expect(JSON.stringify(message.view)).toContain('clefPolicy');
  });

  it('marks a template-only fallback in the view, and only then', () => {
    const context = { weekId: WEEK, disabledGuards: [] };

    const plain = winnerMessage(context, winner, false);
    const fallback = winnerMessage(context, winner, true);

    expect(JSON.stringify(plain.view)).not.toContain(FALLBACK_NOTE);
    expect(JSON.stringify(fallback.view)).toContain(FALLBACK_NOTE);
  });
});

describe('winnerMessage with a variant', () => {
  const context = { weekId: WEEK, disabledGuards: [] } as const;
  const eligible = [makeScoredItem(), makeScoredItem()];

  it('labels the subject and the view, and names the slug', () => {
    const message = winnerMessage(
      { ...context, variant: { kind: 'perspective', topic: 'Security' } },
      winner,
      false,
    );

    expect(message.subject).toBe(
      `Engineering digest ${WEEK} (perspective: Security): ${draft.digest.headline}`,
    );
    expect(message.variant).toBe('perspective-security');
    expect(message.view?.variant).toBe('perspective: Security');
    expect(message.markdown).toBe(winner.markdown);
    expect(message.view?.appendix).toBeUndefined();
  });

  it('appends everything eligible to a complete digest, Markdown and view alike', () => {
    const message = winnerMessage(
      { ...context, variant: { kind: 'complete' } },
      winner,
      false,
      eligible,
    );

    expect(message.variant).toBe('complete');
    expect(message.view?.variant).toBe('complete');
    expect(message.view?.appendix?.groups.flatMap((g) => g.items)).toHaveLength(2);
    expect(message.markdown).toBe(winner.markdown + renderAppendix(message.view!.appendix!));
  });

  it('adds no appendix to a complete digest with nothing eligible', () => {
    const message = winnerMessage({ ...context, variant: { kind: 'complete' } }, winner, false);
    expect(message.view?.appendix).toBeUndefined();
    expect(message.markdown).toBe(winner.markdown);
  });

  it('keeps the subject within 120 characters', () => {
    const long = makeDraft([makeItem()], 'w', { headline: 'h'.repeat(300) });
    const message = winnerMessage(
      { ...context, variant: { kind: 'enrich' } },
      { draft: long, markdown: '#' },
      false,
    );
    expect(message.subject.length).toBeLessThanOrEqual(120);
  });
});
