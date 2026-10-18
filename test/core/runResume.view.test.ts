// A resume sends the saved digest with its view when drafts.json can rebuild it (W8-02).
import { describe, expect, it } from 'vitest';
import { buildDigestView } from '../../src/core/layout.js';
import { renderDigest } from '../../src/core/render.js';
import { loadPartDelivery, resumeDelivery, type ResumeContext } from '../../src/core/runResume.js';
import type { Digest, DeliveryId, GuardCheckId, RunRecord } from '../../src/core/schemas.js';
import type { LogFields, Logger } from '../../src/shared/telemetry.js';
import { makeConfig, makeDigest, makeDigestItem, makeItem, makeRunRecord } from '../builders.js';
import { CapturingDelivery, MemoryRunStore, fixedClock, noopTracer } from '../fakes/index.js';

const WEEK = '2026-W42';
const NOW = '2026-10-16T08:00:00Z';
const WINNER = 'writer-a:31b';
const OFF: readonly GuardCheckId[] = ['clefPolicy'];

const digest: Digest = {
  ...makeDigest([]),
  headline: 'Runners and gateways moved',
  items: [
    makeDigestItem(makeItem(), { urgency: 'act-now', action: 'Upgrade the runner.' }),
    makeDigestItem(makeItem(), { urgency: 'worth-a-look', action: 'run your own gateway.' }),
    makeDigestItem(makeItem(), { urgency: 'good-to-know' }),
  ],
};

const draftsFile = (...entries: { writer: string; digest: Digest }[]): string =>
  JSON.stringify({ drafts: entries, failures: [], rejections: [] });

interface Warning {
  message: string;
  fields: LogFields;
}

function setup(options: {
  drafts?: string | null;
  markdown?: string;
  record?: Partial<RunRecord>;
}) {
  const store = new MemoryRunStore();
  const deliveries = (['markdown', 'email', 'slack'] as DeliveryId[]).map(
    (id) => new CapturingDelivery(id),
  );
  const warnings: Warning[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields = {}) => void warnings.push({ message, fields }),
    error: () => undefined,
    child: () => logger,
  };
  const ctx: ResumeContext = {
    weekId: WEEK,
    dryRun: false,
    startedAt: new Date(NOW),
    logger,
    deps: {
      store,
      deliveries,
      config: makeConfig(),
      clock: fixedClock(NOW),
      tracer: noopTracer,
    },
  };
  const previous = makeRunRecord({
    runId: WEEK,
    status: 'failed',
    sentUrls: digest.items.map((item) => item.url),
    deliveredTo: ['markdown'],
    winner: WINNER,
    disabledGuards: [...OFF],
    error: { step: 'deliver', message: 'Delivery failed on email (SMTP 451)' },
    ...options.record,
  });
  store.records.set(WEEK, previous);
  const markdown = options.markdown ?? renderDigest(digest, { disabledGuards: OFF });
  store.artifacts.set(`${WEEK}/digest.md`, markdown);
  const drafts =
    options.drafts === undefined ? draftsFile({ writer: WINNER, digest }) : options.drafts;
  if (drafts !== null) store.artifacts.set(`${WEEK}/drafts.json`, drafts);
  const email = deliveries.find((delivery) => delivery.id === 'email')!;
  const slack = deliveries.find((delivery) => delivery.id === 'slack')!;
  return { ctx, previous, markdown, email, slack, warnings };
}

async function resume(h: ReturnType<typeof setup>) {
  const part = await loadPartDelivery(h.ctx, h.previous);
  if (!part) throw new Error('Expected a partly delivered week');
  return resumeDelivery(h.ctx, part);
}

describe('resume with a view', () => {
  it('rebuilds the view from the winning draft in drafts.json and sends it with the Markdown', async () => {
    const h = setup({});

    const result = await resume(h);

    const expected = buildDigestView(digest, { disabledGuards: OFF });
    expect(result.record.status).toBe('sent');
    for (const channel of [h.email, h.slack]) {
      expect(channel.digests).toEqual([
        {
          weekId: WEEK,
          subject: `Engineering digest ${WEEK}: ${digest.headline}`,
          markdown: h.markdown,
          view: expected,
        },
      ]);
    }
    expect(expected.footer).toBe('Guards off this week: clefPolicy.');
  });

  it('picks the draft by the winner named in the record, not the first draft', async () => {
    const other = { ...digest, headline: 'Another writer headline' };
    const h = setup({
      drafts: draftsFile({ writer: 'writer-b:9b', digest: other }, { writer: WINNER, digest }),
    });

    await resume(h);

    expect(h.email.digests[0]?.view?.headline).toBe(digest.headline);
  });

  it('reads an old draft without urgency and sends its view as worth-a-look', async () => {
    const oldDigest: Digest = {
      ...digest,
      items: digest.items.map(({ urgency: _urgency, action: _action, ...item }) => item),
    };
    const h = setup({
      markdown: renderDigest(oldDigest, { disabledGuards: OFF }),
      drafts: draftsFile({ writer: WINNER, digest: oldDigest }),
    });

    await resume(h);

    expect(h.email.digests[0]?.view?.groups.map((group) => group.urgency)).toEqual([
      'worth-a-look',
    ]);
  });
});

describe('resume without a view', () => {
  const sentPlain = (h: ReturnType<typeof setup>): void => {
    for (const channel of [h.email, h.slack]) {
      expect(channel.digests).toHaveLength(1);
      expect(channel.digests[0]).not.toHaveProperty('view');
      expect(channel.digests[0]?.markdown).toBe(h.markdown);
    }
  };

  it('sends the Markdown alone when drafts.json is gone', async () => {
    const h = setup({ drafts: null });

    const result = await resume(h);

    expect(result.record.status).toBe('sent');
    sentPlain(h);
    expect(h.email.digests[0]?.subject).toBe(`Engineering digest ${WEEK}: ${digest.headline}`);
  });

  it('sends the Markdown alone, and says why, when drafts.json is not JSON', async () => {
    const h = setup({ drafts: '{ not json' });

    const result = await resume(h);

    expect(result.record.status).toBe('sent');
    sentPlain(h);
    expect(h.warnings.map((w) => w.message)).toContain('Sending the saved digest without its view');
  });

  it('sends the Markdown alone when drafts.json is not the file the run wrote', async () => {
    const h = setup({ drafts: JSON.stringify({ drafts: [{ writer: WINNER }] }) });

    await resume(h);

    sentPlain(h);
  });

  it('sends the Markdown alone when no draft is by the winner', async () => {
    const h = setup({ drafts: draftsFile({ writer: 'writer-b:9b', digest }) });

    await resume(h);

    sentPlain(h);
  });

  it('sends the Markdown alone when the record has no winner', async () => {
    const h = setup({ record: { winner: null } });

    await resume(h);

    sentPlain(h);
  });

  it('sends the Markdown alone when the draft links other items than the record sent', async () => {
    const swapped: Digest = {
      ...digest,
      items: [...digest.items.slice(1), makeDigestItem(makeItem(), { urgency: 'act-now' })],
    };
    const h = setup({ drafts: draftsFile({ writer: WINNER, digest: swapped }) });

    await resume(h);

    sentPlain(h);
  });

  it('sends the Markdown alone when digest.md is not what the draft renders to', async () => {
    const legacy = [
      `# ${digest.headline}`,
      '',
      `_Week ${WEEK}_`,
      '',
      ...digest.items.flatMap((item) => [`[Source](${item.url})`, '']),
    ].join('\n');
    const h = setup({ markdown: legacy });

    const result = await resume(h);

    expect(result.record.status).toBe('sent');
    sentPlain(h);
    expect(h.email.digests[0]?.subject).toBe(`Engineering digest ${WEEK}: ${digest.headline}`);
  });

  it('does not read drafts.json when no channel is missing', async () => {
    const h = setup({
      drafts: '{ not json',
      record: { deliveredTo: ['markdown', 'email', 'slack'] },
    });

    const result = await resume(h);

    expect(result.record.status).toBe('sent');
    expect(h.email.digests).toEqual([]);
    expect(h.warnings.map((w) => w.message)).not.toContain(
      'Sending the saved digest without its view',
    );
  });
});

describe('resume of the layout from before W8-02', () => {
  it('sends a digest.md saved in the old layout, headline and links read from it', async () => {
    const urls = digest.items.map((item) => item.url);
    const legacy = `# Old headline\n\n_Week ${WEEK}_\n\nIntro.\n\n${urls
      .map((url) => `## 1. Item\n\n[Source](${url})`)
      .join('\n\n')}\n`;
    const h = setup({ markdown: legacy, drafts: null });

    const result = await resume(h);

    expect(result.record.status).toBe('sent');
    expect(h.email.digests[0]).toEqual({
      weekId: WEEK,
      subject: `Engineering digest ${WEEK}: Old headline`,
      markdown: legacy,
    });
  });
});
