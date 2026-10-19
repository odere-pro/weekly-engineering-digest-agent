import { describe, expect, it } from 'vitest';
import { digestMessage } from './digestMessage';
import { buildDigestView } from '../../../render/layout';
import { renderDigest } from '../../../render/markdown';
import { makeDigest, makeDigestItem, makeItem } from '../../../../test/builders';
import { WEEK } from '../__fixtures__/endingKit';

const digest = {
  ...makeDigest([]),
  items: [
    makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Upgrade.' }),
    makeDigestItem(makeItem(), { urgency: 'good-to-know' }),
  ],
};
const markdown = renderDigest(digest, { disabledGuards: [] });
const view = buildDigestView(digest, { disabledGuards: [] });

describe('digestMessage', () => {
  it('names the week and the headline in the subject', () => {
    expect(digestMessage(WEEK, 'Runners moved', '# Runners moved\n')).toEqual({
      weekId: WEEK,
      subject: `Engineering digest ${WEEK}: Runners moved`,
      markdown: '# Runners moved\n',
    });
  });

  it('puts a multi-line headline on one line', () => {
    expect(digestMessage(WEEK, '  Runners\n  moved \t today ', '#').subject).toBe(
      `Engineering digest ${WEEK}: Runners moved today`,
    );
  });

  it('leaves the headline out when it is empty', () => {
    expect(digestMessage(WEEK, ' \n ', '#').subject).toBe(`Engineering digest ${WEEK}`);
  });

  it('cuts a long subject, ending it with an ellipsis', () => {
    const { subject } = digestMessage(WEEK, 'word '.repeat(100), '#');

    expect(subject.length).toBeLessThanOrEqual(120);
    expect(subject.endsWith('...')).toBe(true);
  });
});

describe('digestMessage with a view', () => {
  it('carries the view next to the Markdown', () => {
    const message = digestMessage(WEEK, digest.headline, markdown, view);

    expect(message).toEqual({
      weekId: WEEK,
      subject: `Engineering digest ${WEEK}: ${digest.headline}`,
      markdown,
      view,
    });
    expect(message.view).toBe(view);
  });

  it('has no view key when it is given none, so a channel falls back to the Markdown', () => {
    const message = digestMessage(WEEK, digest.headline, markdown);

    expect(message).not.toHaveProperty('view');
  });
});
