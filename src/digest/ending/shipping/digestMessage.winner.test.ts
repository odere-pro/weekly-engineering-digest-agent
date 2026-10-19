import { describe, expect, it } from 'vitest';
import { winnerMessage } from './digestMessage';
import { buildDigestView, FALLBACK_NOTE } from '../../../render/layout';
import { makeDraft, makeItem } from '../../../../test/builders';
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
