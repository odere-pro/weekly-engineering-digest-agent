import { describe, expect, it } from 'vitest';
import { feedA, goodItem, recording } from '../__fixtures__/conformanceKit';
import { serveRecording } from './serveRecording';

const page = '<html><head><meta name="description" content="From the page."></head></html>';
const withPage = {
  ...recording(feedA, [goodItem('feed-a', 1)]),
  pages: { 'https://openai.com/news/post-1': page },
};

describe('serveRecording', () => {
  it('serves the feed for the recorded request url and a recorded page for its url', async () => {
    const serve = serveRecording(withPage);

    expect(await (await serve(feedA.url)).text()).toBe('<rss/>');
    const served = await serve(new URL('https://openai.com/news/post-1'));
    expect(await served.text()).toBe(page);
    expect(served.headers.get('content-type')).toContain('text/html');
  });

  it('answers 404 for a url that was not recorded', async () => {
    const serve = serveRecording(withPage);

    expect((await serve('https://openai.com/news/other')).status).toBe(404);
    expect((await serve(new Request('https://openai.com/constructor'))).status).toBe(404);
  });

  it('serves the recorded status and content type of the feed', async () => {
    const served = await serveRecording(withPage)(feedA.url);

    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/xml');
  });

  it('answers 200 and sets no content type of its own when the recording has neither', async () => {
    const bare = {
      ...withPage,
      response: { url: feedA.url, fetchedAt: '2026-10-17T08:00:00.000Z', bodyFile: 'body.xml' },
    };

    const served = await serveRecording(bare)(feedA.url);

    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/plain;charset=UTF-8'); // the Response default
    expect(await served.text()).toBe('<rss/>');
  });

  it('serves a recorded error status with its body', async () => {
    const failing = { ...withPage, response: { ...withPage.response, status: 503 } };

    const served = await serveRecording(failing)(feedA.url);

    expect(served.status).toBe(503);
    expect(await served.text()).toBe('<rss/>');
  });

  it('reads the url of a Request too', async () => {
    const served = await serveRecording(withPage)(new Request(feedA.url));

    expect(await served.text()).toBe('<rss/>');
  });
});
