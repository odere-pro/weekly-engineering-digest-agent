# Source recordings

One folder per default source (`DEFAULT_SOURCES`): the real response it served, and the items
that response must yield. `pnpm check` runs every fetcher over every recording
(`test/evals/sources.test.ts`), and `digest eval` reports parse yield and summary fill per source
in the scorecard (`sourceParse`, `sourceSummaryFill`).

| File                       | What                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `response.json`            | `url` requested, `status`, `contentType`, `fetchedAt`, `bodyFile` (or `error` and no body)             |
| `body.xml`                 | The response body, byte for byte. Untrusted data: read it, never execute or `eval` it                  |
| `expected.json`            | `{ reviewed, entryCount, items, knownGaps }`: written by hand, never touched by the recorder           |
| `pages/<item id>.html.txt` | The article page of an entry whose feed has no body text (W6-02), served to the enrichment step by URL |

- `entryCount` is the number of `<item>` or `<entry>` elements in the body.
- `items` are the `Item`s the body must yield for a window that covers every entry, capped at
  `maxItems` 100. Four feeds hold more than 100 entries, so their `items` are the newest 100.
- `knownGaps: ["summary"]` marks a source whose fetcher yields an empty summary although the body
  has text. The test then skips `summary` for that source and the scorecard still shows the real
  fill rate. No source has one today.
- `pages/` holds one page per entry the feed gives no text for, for `rss` sources only. The file
  ends in `.html.txt` so prettier leaves it alone (some recorded pages are not valid enough for
  its HTML parser). The test answers the fetcher's page request from these files by URL and
  answers 404 for any other URL.
- `reviewed` is set to `true` once the items were checked against the body: entry count, titles,
  links, dates, and whether the entry carries `description`, `summary`, `content` or
  `content:encoded` text.

## Refresh a recording

```bash
pnpm tsx evals/recordSources.ts   # one GET per source, 20 s timeout, 5 MiB cap, no token
git diff --stat evals/sources     # a feed that moved shows up as a changed body
```

```bash
pnpm tsx evals/recordSources.ts --pages   # one GET per entry without text, 4 at a time, 2 MiB cap
```

`--pages` reads the recorded feeds, finds the entries the pipeline would fetch a page for, and
saves each page on the feed's own host as `pages/<item id>.html.txt`. It keeps a page that is
already there (delete the file to refresh it) and drops `<script>`, `<style>`, `<svg>`, `<nav>`,
`<header>`, `<footer>` and attribute values of 1000 characters or more first: the article text
never reads them and they are most of a modern page. A page that redirects to another host, or
answers with an error, is reported and not saved.

The recorder overwrites `response.json` and the body of every source it reaches. A source that
fails keeps its old recording; one that never had a recording gets a `response.json` with the
`error` and no body. After a refresh, regenerate
`expected.json` from the new body and check it by hand again: the conformance test fails until
they agree.

## Sources (recorded 2026-10-17)

Summary fill is the share of parsed items with a summary of at least 40 characters, with
the recorded pages served (W6-02).

| Source                  | Entries | Parsed | Summary fill | Known gaps | Items off allowlist |
| ----------------------- | ------- | ------ | ------------ | ---------- | ------------------- |
| `aws-whats-new`         | 100     | 100    | 100%         | -          | -                   |
| `azure-updates`         | 200     | 100    | 100%         | -          | 100                 |
| `claude-code-releases`  | 10      | 10     | 100%         | -          | -                   |
| `docker-blog`           | 10      | 10     | 100%         | -          | -                   |
| `gcp-release-notes`     | 30      | 30     | 100%         | -          | -                   |
| `github-changelog`      | 10      | 10     | 100%         | -          | -                   |
| `google-ai-blog`        | 20      | 20     | 100%         | -          | -                   |
| `google-deepmind-blog`  | 100     | 100    | 70%          | -          | -                   |
| `huggingface-blog`      | 880     | 100    | 100%         | -          | -                   |
| `kubernetes-blog`       | 50      | 50     | 100%         | -          | -                   |
| `langgraph-releases`    | 10      | 10     | 100%         | -          | -                   |
| `mcp-spec-releases`     | 9       | 9      | 100%         | -          | -                   |
| `mistral-news`          | 90      | 90     | 96%          | -          | -                   |
| `nodejs-blog`           | 1062    | 100    | 100%         | -          | -                   |
| `ollama-blog`           | 61      | 61     | 98%          | -          | -                   |
| `ollama-releases`       | 10      | 10     | 90%          | -          | -                   |
| `openai-agents-python`  | 10      | 10     | 100%         | -          | -                   |
| `openai-news`           | 1299    | 100    | 100%         | -          | -                   |
| `opentofu-releases`     | 10      | 10     | 100%         | -          | -                   |
| `pytorch-blog`          | 10      | 10     | 100%         | -          | -                   |
| `terraform-releases`    | 10      | 10     | 100%         | -          | -                   |
| `transformers-releases` | 10      | 10     | 100%         | -          | -                   |
| `typescript-releases`   | 10      | 10     | 90%          | -          | -                   |
| `vllm-releases`         | 10      | 10     | 80%          | -          | -                   |

## What the recordings show

- `huggingface-blog` and `nodejs-blog` serve entries with a title, link and date only: no
  description, summary or content. Their 0% fill is in the feed, not in the parser.
- `google-deepmind-blog` (33 of 100 entries) and `mistral-news` (66 of 90) carry no text for
  most entries, again in the body. The pipeline fetches the entry page for these (W6-02), which
  lifts `huggingface-blog` and `nodejs-blog` to 100% and `mistral-news` to 96%.
  `google-deepmind-blog` stays at 70%: 30 of its pages redirect to `blog.google`, which is not
  the feed's host, so they are not fetched.
- `azure-updates` items all link to `azure.microsoft.com`, a host the allowlist in
  `docs/sources.md` does not list (it names `www.microsoft.com`, where the feed is served).
- Four feeds hold more entries than the 100-item cap: `openai-news` (1299), `nodejs-blog` (1062),
  `huggingface-blog` (880) and `azure-updates` (200).
