import { describe, expect, it } from 'vitest';
import { knownSecrets, redactDelivery, redactStore } from '../../src/app/redacting.js';
import { createRedactor, REDACTED } from '../../src/observability/redact.js';
import type { DigestMessage, FailureNote } from '../../src/ports/Delivery.js';
import { makeRunRecord } from '../builders.js';
import { CapturingDelivery, MemoryRunStore } from '../fakes/index.js';

const SMTP_PASSWORD = 'smtp-password-4f9a';
const WEBHOOK_PATH = '/services/T000/B000/slack-secret-7c1e';
const SLACK_WEBHOOK_URL = `https://hooks.slack.test${WEBHOOK_PATH}`;
const GITHUB_TOKEN = 'ghp_github-token-82bd';
const redactor = createRedactor([SMTP_PASSWORD, SLACK_WEBHOOK_URL, GITHUB_TOKEN, WEBHOOK_PATH]);

describe('knownSecrets', () => {
  it('lists every secret value that is set', () => {
    const secrets = knownSecrets({ SMTP_PASSWORD, GITHUB_TOKEN });

    expect(secrets).toEqual([SMTP_PASSWORD, GITHUB_TOKEN]);
  });

  it('leaves out secrets that are empty or missing', () => {
    expect(knownSecrets({ SMTP_PASSWORD: '', GITHUB_TOKEN: undefined })).toEqual([]);
    expect(knownSecrets({})).toEqual([]);
  });

  it('adds the path of the Slack webhook, which is the secret part of the URL', () => {
    const secrets = knownSecrets({ SLACK_WEBHOOK_URL });

    expect(secrets).toEqual([SLACK_WEBHOOK_URL, WEBHOOK_PATH]);
  });

  it('copes with a webhook that is not a URL, and with one that has no path', () => {
    expect(knownSecrets({ SLACK_WEBHOOK_URL: 'not a url' })).toEqual(['not a url']);
    expect(knownSecrets({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test' })).toEqual([
      'https://hooks.slack.test',
    ]);
  });
});

describe('redactStore', () => {
  function setup() {
    const inner = new MemoryRunStore();
    return { inner, store: redactStore(inner, redactor) };
  }

  it('redacts a secret in every string of the run record before it is saved', async () => {
    const { inner, store } = setup();
    const record = makeRunRecord({
      status: 'failed',
      error: { message: `SMTP refused ${SMTP_PASSWORD}`, step: 'deliver' },
      failedSources: [{ sourceId: 'gh', error: `401 for token ${GITHUB_TOKEN}` }],
    });

    await store.saveRunRecord(record);

    const saved = inner.records.get('2026-W42');
    expect(saved?.error?.message).toBe(`SMTP refused ${REDACTED}`);
    expect(saved?.failedSources[0]?.error).toBe(`401 for token ${REDACTED}`);
    expect(JSON.stringify(saved)).not.toContain(SMTP_PASSWORD);
    expect(JSON.stringify(saved)).not.toContain(GITHUB_TOKEN);
  });

  it('saves a record without secrets exactly as it was', async () => {
    const { inner, store } = setup();
    const record = makeRunRecord({
      deliveredTo: ['markdown'],
      sentUrls: ['https://example.test/a'],
      timings: [{ step: 'collect', ms: 12 }],
    });

    await store.saveRunRecord(record);

    expect(inner.records.get('2026-W42')).toEqual(record);
  });

  it('does not change the record it was given', async () => {
    const { store } = setup();
    const record = makeRunRecord({ error: { message: `leak ${SMTP_PASSWORD}` } });

    await store.saveRunRecord(record);

    expect(record.error?.message).toBe(`leak ${SMTP_PASSWORD}`);
  });

  it('refuses to save a record it cannot redact, rather than save it as it is', async () => {
    const { inner, store } = setup();
    const record = makeRunRecord();
    Object.defineProperty(record, 'winner', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable');
      },
    });

    await expect(store.saveRunRecord(record)).rejects.toThrow(/redact/i);

    expect(inner.records.size).toBe(0);
  });

  it('does not save a record that a secret would rewrite into something invalid', async () => {
    const inner = new MemoryRunStore();
    const store = redactStore(inner, createRedactor(['sent']));

    await expect(store.saveRunRecord(makeRunRecord({ status: 'sent' }))).rejects.toThrow(
      /Could not redact the run record for 2026-W42/,
    );

    expect(inner.records.size).toBe(0);
  });

  it('redacts an artifact, JSON or Markdown, before it is saved', async () => {
    const { inner, store } = setup();
    const json = JSON.stringify({ note: `token ${GITHUB_TOKEN}` });

    await store.saveArtifact('2026-W42', 'error.json', json);
    await store.saveArtifact('2026-W42', 'digest.md', `# Digest\n\nSee ${SLACK_WEBHOOK_URL}\n`);

    expect(inner.artifacts.get('2026-W42/error.json')).toBe(`{"note":"token ${REDACTED}"}`);
    expect(inner.artifacts.get('2026-W42/digest.md')).toBe(`# Digest\n\nSee ${REDACTED}\n`);
  });

  it('redacts the escaped and encoded forms of a secret in an artifact', async () => {
    const quoted = makeRedactorFor('pa"ss#1');
    const inner = new MemoryRunStore();
    const store = redactStore(inner, quoted);

    await store.saveArtifact('2026-W42', 'error.json', JSON.stringify({ p: 'pa"ss#1' }));
    await store.saveArtifact('2026-W42', 'digest.md', 'https://x.test/?p=pa%22ss%231');

    expect(inner.artifacts.get('2026-W42/error.json')).toBe(`{"p":"${REDACTED}"}`);
    expect(inner.artifacts.get('2026-W42/digest.md')).toBe(`https://x.test/?p=${REDACTED}`);
  });

  it('leaves an artifact without secrets exactly as it was', async () => {
    const { inner, store } = setup();

    await store.saveArtifact('2026-W42', 'items.json', '[]\n');

    expect(inner.artifacts.get('2026-W42/items.json')).toBe('[]\n');
  });

  it('passes everything else straight through', async () => {
    const { inner, store } = setup();
    inner.records.set(
      '2026-W41',
      makeRunRecord({ runId: '2026-W41', sentUrls: ['https://a.test/'] }),
    );
    inner.artifacts.set('2026-W41/digest.md', 'saved');

    await expect(store.hasSentDigest('2026-W41')).resolves.toBe(true);
    await expect(store.readArtifact('2026-W41', 'digest.md')).resolves.toBe('saved');
    await expect(store.getRunRecord('2026-W41')).resolves.toBe(inner.records.get('2026-W41'));
    await expect(store.sentUrls('2026-W42', 2)).resolves.toEqual(new Set(['https://a.test/']));
    await expect(store.listRuns()).resolves.toEqual([...inner.records.values()]);
    await expect(store.prune('2026-W42', 8)).resolves.toEqual([]);
    const lock = await store.acquireLock('2026-W42');
    expect(inner.isLocked).toBe(true);
    await lock.release();
    expect(inner.isLocked).toBe(false);
  });
});

function makeRedactorFor(secret: string) {
  return createRedactor([secret]);
}

describe('redactDelivery', () => {
  const message: DigestMessage = {
    weekId: '2026-W42',
    subject: `Digest for ${SMTP_PASSWORD}`,
    markdown: `# Digest\n\nToken ${GITHUB_TOKEN}\n`,
  };
  const note: FailureNote = {
    weekId: '2026-W42',
    step: 'deliver',
    message: `SMTP refused ${SMTP_PASSWORD}`,
  };

  it('keeps the id of the channel', () => {
    expect(redactDelivery(new CapturingDelivery('email'), redactor).id).toBe('email');
  });

  it('redacts every text of the digest view before it is sent', async () => {
    const inner = new CapturingDelivery('slack');
    const withView: DigestMessage = {
      ...message,
      view: {
        weekId: '2026-W42',
        title: `Week 2026-W42 ${GITHUB_TOKEN}`,
        headline: `Headline ${SMTP_PASSWORD}`,
        groups: [
          {
            urgency: 'act-now',
            label: 'Act now',
            items: [
              {
                title: `Release ${GITHUB_TOKEN}`,
                url: 'https://example.test/release',
                whatChanged: `Changed ${SLACK_WEBHOOK_URL}`,
                action: `Rotate ${SMTP_PASSWORD}`,
              },
            ],
          },
        ],
        footer: `Footer ${WEBHOOK_PATH}`,
      },
    };

    await redactDelivery(inner, redactor).sendDigest(withView);

    const sent = JSON.stringify(inner.digests[0]?.view);
    for (const secret of [SMTP_PASSWORD, GITHUB_TOKEN, SLACK_WEBHOOK_URL, WEBHOOK_PATH]) {
      expect(sent).not.toContain(secret);
    }
    expect(inner.digests[0]?.view?.groups[0]?.items[0]?.url).toBe('https://example.test/release');
  });

  it('redacts the subject and the text of a digest before it is sent', async () => {
    const inner = new CapturingDelivery('slack');

    await redactDelivery(inner, redactor).sendDigest(message);

    expect(inner.digests).toEqual([
      {
        weekId: '2026-W42',
        subject: `Digest for ${REDACTED}`,
        markdown: `# Digest\n\nToken ${REDACTED}\n`,
      },
    ]);
  });

  it('redacts the message of a failure note and keeps its week and step', async () => {
    const inner = new CapturingDelivery('slack');

    await redactDelivery(inner, redactor).sendFailure(note);

    expect(inner.failures).toEqual([
      { weekId: '2026-W42', step: 'deliver', message: `SMTP refused ${REDACTED}` },
    ]);
  });

  it('sends a note without a step as it is', async () => {
    const inner = new CapturingDelivery();

    await redactDelivery(inner, redactor).sendFailure({ weekId: '2026-W42', message: 'plain' });

    expect(inner.failures).toEqual([{ weekId: '2026-W42', message: 'plain' }]);
  });

  it('does not change the message it was given', async () => {
    await redactDelivery(new CapturingDelivery(), redactor).sendDigest(message);

    expect(message.subject).toBe(`Digest for ${SMTP_PASSWORD}`);
  });

  it('lets the failure of the channel through unchanged', async () => {
    const inner = new CapturingDelivery();
    inner.failWith = new Error('Slack webhook answered HTTP 503');

    await expect(redactDelivery(inner, redactor).sendDigest(message)).rejects.toBe(inner.failWith);
  });
});
