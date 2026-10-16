import { describe, expect, it, vi } from 'vitest';
import { createSlackDelivery } from '../../../src/adapters/delivery/slack.js';

const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/s3cr3tT0ken';
const SECRET_PATH = '/services/T000/B000/s3cr3tT0ken';

const message = {
  weekId: '2026-W42',
  subject: 'Engineering digest 2026-W42',
  markdown: '# Digest\n\n**Ollama** shipped [0.9](https://example.com/a)\n',
};

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function okFetch(): FetchMock {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok', { status: 200 })));
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

function postedText(fetchMock: FetchMock): string {
  return (bodyOf(fetchMock.mock.calls[0]?.[1]) as { text: string }).text;
}

describe('createSlackDelivery', () => {
  it('identifies as the slack channel', () => {
    expect(createSlackDelivery({ webhookUrl: WEBHOOK, fetch: okFetch() }).id).toBe('slack');
  });

  describe('sendDigest', () => {
    it('POSTs JSON { text } to the webhook with the digest as Slack mrkdwn', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest(message);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(WEBHOOK);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(bodyOf(init)).toEqual({
        text: '*Digest*\n\n*Ollama* shipped <https://example.com/a|0.9>\n',
      });
    });

    it('falls back to the global fetch when none is injected', async () => {
      const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      await createSlackDelivery({ webhookUrl: WEBHOOK }).sendDigest(message);

      expect(globalFetch).toHaveBeenCalledWith(
        WEBHOOK,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on a non-2xx answer without the webhook url or its secret in the error', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(`bad token ${WEBHOOK}`, { status: 404 })),
      );
      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendDigest(message)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const text = `${(error as Error).message} ${String((error as Error).stack)}`;
      expect(text).toContain('404');
      expect(text).not.toContain(WEBHOOK);
      expect(text).not.toContain('s3cr3tT0ken');
    });

    it('wraps a network failure and strips the webhook url from its message', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError(`Failed to parse URL from ${WEBHOOK}`)),
      );
      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendDigest(message)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/slack/i);
      expect((error as Error).message).not.toContain('s3cr3tT0ken');
      expect((error as Error).message).not.toContain(SECRET_PATH);
      expect((error as Error).cause).toBeUndefined();
    });

    it('also strips the normalized form of the url from a network failure', async () => {
      const webhookUrl = 'HTTPS://Hooks.Slack.Test:443/services/T000/B000/s3cr3tT0ken';
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(
          new Error('connect failed https://hooks.slack.test/services/T000/B000/s3cr3tT0ken'),
        ),
      );

      await expect(
        createSlackDelivery({ webhookUrl, fetch: fetchMock }).sendDigest(message),
      ).rejects.toThrow(/^(?!.*s3cr3tT0ken)/s);
    });

    it('copes with a webhook url that has no path to hide', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new Error('connect failed https://hooks.slack.test/ refused')),
      );

      await expect(
        createSlackDelivery({
          webhookUrl: 'https://hooks.slack.test',
          fetch: fetchMock,
        }).sendDigest(message),
      ).rejects.toThrow(/^Slack webhook request failed: connect failed \[redacted\] refused$/);
    });

    it('copes with a webhook url that is not a valid url', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new Error('Invalid URL not-a-url')),
      );

      await expect(
        createSlackDelivery({ webhookUrl: 'not-a-url', fetch: fetchMock }).sendDigest(message),
      ).rejects.toThrow(/slack/i);
    });

    it('reports a non-Error rejection', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValue('socket hang up');

      await expect(
        createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest(message),
      ).rejects.toThrow(/socket hang up/);
    });
  });

  describe('sendFailure', () => {
    it('posts one short line with the week, step and message', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendFailure({
        weekId: '2026-W42',
        step: 'write',
        message: 'Writer panel returned no draft',
      });

      const text = postedText(fetchMock);
      expect(text).toContain('2026-W42');
      expect(text).toContain('write');
      expect(text).toContain('Writer panel returned no draft');
      expect(text).not.toContain('\n');
    });

    it('collapses a multi-line message and cuts a very long one', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendFailure({
        weekId: '2026-W42',
        message: `first line\n  second line\n${'x '.repeat(500)}`,
      });

      const text = postedText(fetchMock);
      expect(text).not.toContain('\n');
      expect(text).toContain('first line second line');
      expect(text.length).toBeLessThan(500);
      expect(text.endsWith('...')).toBe(true);
    });

    it('removes the webhook url from a message that echoes it', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendFailure({
        weekId: '2026-W42',
        message: `request to ${WEBHOOK} failed`,
      });

      const text = postedText(fetchMock);
      expect(text).not.toContain('s3cr3tT0ken');
      expect(text).toContain('[redacted]');
    });

    it('does not turn a link in the message into a Slack control token', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendFailure({
        weekId: '2026-W42',
        message: 'bad draft: [click](!channel)',
      });

      expect(postedText(fetchMock)).not.toMatch(/<[!@#]/);
    });

    it('escapes Slack control characters in the message', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendFailure({
        weekId: '2026-W42',
        message: 'bad input <!channel>',
      });

      expect(postedText(fetchMock)).toContain('&lt;!channel&gt;');
    });

    it('throws without the webhook url when Slack rejects the note', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response('', { status: 500 })),
      );

      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendFailure({ weekId: '2026-W42', message: 'boom' })
        .catch((caught: unknown) => caught);

      expect((error as Error).message).toContain('500');
      expect((error as Error).message).not.toContain('s3cr3tT0ken');
    });
  });
});
