import type { SourceRecording } from '../recordings/types';

const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The feed for the URL the recorder requested, a recorded page for its URL, 404 for the rest. */
export function serveRecording({ response, body, pages }: SourceRecording): typeof fetch {
  return (input) => {
    const url = requestedUrl(input);
    if (url === response.url) {
      return Promise.resolve(
        new Response(body, {
          status: response.status ?? 200,
          headers: response.contentType ? { 'content-type': response.contentType } : {},
        }),
      );
    }
    const page = Object.hasOwn(pages, url) ? pages[url] : undefined;
    return Promise.resolve(
      page === undefined
        ? new Response('not recorded', { status: 404 })
        : new Response(page, { headers: PAGE_HEADERS }),
    );
  };
}
