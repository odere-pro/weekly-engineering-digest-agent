import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryError } from './errors/deliveryError';
import { createSlackDelivery } from './slack';
import { toSlackBlocks } from './slackBlocks/toSlackBlocks';
import type { DigestView } from '../../render/digestView';

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

function postedBody(fetchMock: FetchMock): string {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  return typeof body === 'string' ? body : '';
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

    it('refuses a non-https webhook without contacting it', async () => {
      const fetchMock = okFetch();
      const httpWebhook = 'http://hooks.slack.test/services/T000/B000/s3cr3tT0ken';
      const delivery = createSlackDelivery({ webhookUrl: httpWebhook, fetch: fetchMock });

      const digestError = await delivery.sendDigest(message).catch((e: unknown) => e);
      const failureError = await delivery
        .sendFailure({ weekId: '2026-W42', step: 'write', message: 'boom' })
        .catch((e: unknown) => e);

      expect(fetchMock).not.toHaveBeenCalled();
      for (const error of [digestError, failureError]) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/slack.*https/i);
        expect((error as Error).message).not.toContain(SECRET_PATH);
        expect((error as Error).message).not.toContain('s3cr3tT0ken');
      }
    });

    it('refuses a webhook url that is not a url at all', async () => {
      const fetchMock = okFetch();
      await expect(
        createSlackDelivery({ webhookUrl: 'not-a-url', fetch: fetchMock }).sendDigest(message),
      ).rejects.toThrow(/slack.*https/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts an https webhook in any letter case', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({
        webhookUrl: 'HTTPS://Hooks.Slack.Test/services/T000/B000/s3cr3tT0ken',
        fetch: fetchMock,
      }).sendDigest(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a non-Error rejection', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValue('socket hang up');

      await expect(
        createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest(message),
      ).rejects.toThrow(/socket hang up/);
    });
  });

  describe('sendDigest with a laid-out view', () => {
    const view: DigestView = JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'slackBlocks', '__fixtures__', 'digest-view.json'),
        'utf8',
      ),
    ) as DigestView;
    const withView = { ...message, view };

    it('POSTs { text, blocks } built from the view, not the Markdown', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest(withView);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(WEBHOOK);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      const body = bodyOf(init) as { text: string; blocks: { type: string }[] };
      expect(Object.keys(body).toSorted()).toEqual(['blocks', 'text']);
      expect(body).toEqual(toSlackBlocks(view));
      expect(body.blocks[0]?.type).toBe('header');
      expect(JSON.stringify(body)).not.toContain('Ollama** shipped');
    });

    it('still posts the Markdown conversion when there is no view', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest(message);

      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
        text: '*Digest*\n\n*Ollama* shipped <https://example.com/a|0.9>\n',
      });
    });

    it('drops invisible format characters from the Markdown it posts when there is no view', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest({
        ...message,
        markdown: '# Dig\u{202E}est\n\n**Olla\u{200B}ma** shipped\n\u{E0041}\u{2066}done\n',
      });

      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
        text: '*Dig est*\n\n*Olla ma* shipped\ndone\n',
      });
    });

    it('never puts the webhook url in the posted message, even when collected text echoes it', async () => {
      const fetchMock = okFetch();
      const echoing: DigestView = {
        ...view,
        headline: `see ${WEBHOOK}`,
        groups: [
          {
            urgency: 'act-now',
            label: 'Act now',
            items: [
              {
                title: SECRET_PATH,
                url: WEBHOOK,
                whatChanged: `posted to ${WEBHOOK}`,
                action: `then ${WEBHOOK}`,
              },
            ],
          },
        ],
      };
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest({
        ...message,
        view: echoing,
      });

      const posted = postedBody(fetchMock);
      expect(posted).not.toContain('s3cr3tT0ken');
      expect(posted).not.toContain(SECRET_PATH);
      expect(posted).toContain('[redacted]');
      expect(() => JSON.parse(posted) as unknown).not.toThrow();
    });

    it('does not add the webhook url to an ordinary digest', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendDigest(withView);

      const posted = postedBody(fetchMock);
      expect(posted).not.toContain('hooks.slack.test');
      expect(posted).not.toContain('[redacted]');
    });

    it('refuses a non-https webhook without contacting it', async () => {
      const fetchMock = okFetch();
      const delivery = createSlackDelivery({
        webhookUrl: 'http://hooks.slack.test/services/T000/B000/s3cr3tT0ken',
        fetch: fetchMock,
      });

      await expect(delivery.sendDigest(withView)).rejects.toThrow(/slack.*https/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a refused post as a typed error without the webhook url', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response('invalid_blocks', { status: 400 })),
      );

      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendDigest(withView)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DeliveryError);
      expect((error as DeliveryError).status).toBe(400);
      expect((error as DeliveryError).message).not.toContain('s3cr3tT0ken');
    });
  });

  describe('typed errors', () => {
    it.each([404, 429, 500, 503])(
      'carries the HTTP status %i of a refused post',
      async (status) => {
        const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status })));
        const delivery = createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock });

        const digestError = await delivery.sendDigest(message).catch((caught: unknown) => caught);
        const failureError = await delivery
          .sendFailure({ weekId: '2026-W42', message: 'boom' })
          .catch((caught: unknown) => caught);

        for (const error of [digestError, failureError]) {
          expect(error).toBeInstanceOf(DeliveryError);
          expect((error as DeliveryError).status).toBe(status);
          expect((error as DeliveryError).message).toBe(`Slack webhook answered HTTP ${status}`);
        }
      },
    );

    it('carries the connection code fetch hides on the cause, and a redacted cause', async () => {
      const cause = Object.assign(new Error(`connect ECONNREFUSED for ${WEBHOOK}`), {
        code: 'ECONNREFUSED',
      });
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError('fetch failed', { cause })),
      );

      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendDigest(message)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DeliveryError);
      const delivery = error as DeliveryError;
      expect(delivery.code).toBe('ECONNREFUSED');
      expect(delivery.status).toBeUndefined();
      expect((delivery.cause as Error).message).toBe('connect ECONNREFUSED for [redacted]');
    });

    it('names the inner errors of a refused dual-stack connection', async () => {
      const refused = (address: string): Error =>
        Object.assign(new Error(`connect ECONNREFUSED ${address}:443`), { code: 'ECONNREFUSED' });
      const aggregate = Object.assign(new AggregateError([refused('::1'), refused('127.0.0.1')]), {
        code: 'ECONNREFUSED',
      });
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError('fetch failed', { cause: aggregate })),
      );

      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendFailure({ weekId: '2026-W42', message: 'boom' })
        .catch((caught: unknown) => caught);

      expect((error as DeliveryError).code).toBe('ECONNREFUSED');
      expect(((error as DeliveryError).cause as Error).message).toBe(
        'connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443',
      );
    });

    it('has no connection code for a timeout of the whole request', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
      );

      const error = await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock })
        .sendDigest(message)
        .catch((caught: unknown) => caught);

      expect((error as DeliveryError).code).toBeUndefined();
      expect((error as DeliveryError).status).toBeUndefined();
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

    it('drops invisible format characters from the message', async () => {
      const fetchMock = okFetch();
      await createSlackDelivery({ webhookUrl: WEBHOOK, fetch: fetchMock }).sendFailure({
        weekId: '2026-W42',
        step: 'write',
        message: 'bad\u{202E}draft\u{200B}\u{E0041}!',
      });

      const text = postedText(fetchMock);
      expect(text).toBe('Weekly digest 2026-W42 failed at write: bad draft !');
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
