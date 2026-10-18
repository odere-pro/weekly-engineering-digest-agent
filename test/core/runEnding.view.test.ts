// The laid-out view travels in the DigestMessage (W8-02).
import { describe, expect, it } from 'vitest';
import { buildDigestView } from '../../src/core/layout.js';
import { renderDigest } from '../../src/core/render.js';
import { digestMessage, shipDigest } from '../../src/core/runEnding.js';
import { makeDigest, makeDigestItem, makeItem } from '../builders.js';
import { CapturingDelivery } from '../fakes/index.js';

const WEEK = '2026-W42';
const digest = {
  ...makeDigest([]),
  items: [
    makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Upgrade.' }),
    makeDigestItem(makeItem(), { urgency: 'good-to-know' }),
  ],
};
const markdown = renderDigest(digest, { disabledGuards: [] });
const view = buildDigestView(digest, { disabledGuards: [] });

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

describe('shipDigest with a view', () => {
  it('hands the same message, view included, to every channel', async () => {
    const channels = [new CapturingDelivery('email'), new CapturingDelivery('slack')];
    const message = digestMessage(WEEK, digest.headline, markdown, view);

    await shipDigest(channels, message, []);

    expect(channels.map((channel) => channel.digests[0]?.view)).toEqual([view, view]);
  });
});
