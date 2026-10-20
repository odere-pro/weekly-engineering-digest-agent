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

  it('drops bidi, zero-width and control characters from the headline, as the body does', () => {
    const headline = 'Security fix ‮gnirps‬ ​patch\u0007 \u001B[31mRED';

    expect(digestMessage(WEEK, headline, '#').subject).toBe(
      `Engineering digest ${WEEK}: Security fix gnirps patch [31mRED`,
    );
  });

  it('drops isolates, tag characters and the byte order mark from the headline', () => {
    const headline = '⁦Runners⁩ moved\u{E0041}\u{E0042}﻿ today';

    expect(digestMessage(WEEK, headline, '#').subject).toBe(
      `Engineering digest ${WEEK}: Runners moved today`,
    );
  });

  it('leaves the headline out when nothing but invisible characters is in it', () => {
    expect(digestMessage(WEEK, '​‮\u0007', '#').subject).toBe(`Engineering digest ${WEEK}`);
  });

  it('keeps a joined emoji in the headline whole, as the other channels do', () => {
    const headline = 'Shipped by \u{1F469}\u{200D}\u{1F4BB} today';

    expect(digestMessage(WEEK, headline, '#').subject).toBe(
      `Engineering digest ${WEEK}: ${headline}`,
    );
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
