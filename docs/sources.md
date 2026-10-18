# Default sources

The 24 feeds in `DEFAULT_SOURCES` ([`src/sources/defaultSources.ts`](../src/config/defaultSources.ts)),
mirrored in [`digest.config.example.json`](../digest.config.example.json). A test keeps the two,
and this file, in sync. Every feed was fetched and parsed on 2026-10-16.

Only these hosts are contacted at collection time: `openai.com`, `deepmind.google`,
`blog.google`, `mistral.ai`, `huggingface.co`, `pytorch.org`, `ollama.com`, `github.com`,
`nodejs.org`, `kubernetes.io`, `www.docker.com`, `github.blog`, `aws.amazon.com`,
`docs.cloud.google.com`, `www.microsoft.com`.

With `GITHUB_TOKEN` set, the GitHub fetcher also calls `api.github.com` (REST mode).

## Sources

`area` is a classifier hint: `ai-models`, `ai-tooling`, `platform`, `cloud`. A run passes it to
the model as a line `Source tag: <area>`. The classifier still picks each item's area itself,
from your `focusAreas` or `other`.

| id                      | URL                                                              | kind   | area       | why it is in                                                          |
| ----------------------- | ---------------------------------------------------------------- | ------ | ---------- | --------------------------------------------------------------------- |
| `openai-news`           | https://openai.com/news/rss.xml                                  | rss    | ai-models  | OpenAI's official news: model, API and product launches               |
| `google-deepmind-blog`  | https://deepmind.google/blog/rss.xml                             | rss    | ai-models  | Google DeepMind research and Gemini model announcements               |
| `google-ai-blog`        | https://blog.google/innovation-and-ai/technology/ai/rss/         | rss    | ai-models  | Google's product-side AI announcements (Gemini, tooling)              |
| `mistral-news`          | https://mistral.ai/news/rss                                      | rss    | ai-models  | Mistral model and platform news                                       |
| `huggingface-blog`      | https://huggingface.co/blog/feed.xml                             | rss    | ai-models  | Open-model releases and ecosystem changes                             |
| `pytorch-blog`          | https://pytorch.org/blog/feed/                                   | rss    | ai-tooling | PyTorch release and ecosystem posts (the repo's releases are CI tags) |
| `ollama-blog`           | https://ollama.com/blog/rss.xml                                  | rss    | ai-tooling | Ollama feature and model-availability posts; this agent runs on it    |
| `ollama-releases`       | https://github.com/ollama/ollama                                 | github | ai-tooling | Ollama runtime releases                                               |
| `vllm-releases`         | https://github.com/vllm-project/vllm                             | github | ai-tooling | Main open-source LLM inference server                                 |
| `transformers-releases` | https://github.com/huggingface/transformers                      | github | ai-tooling | Reference library for new open model architectures                    |
| `claude-code-releases`  | https://github.com/anthropics/claude-code                        | github | ai-tooling | Anthropic's coding agent; no Anthropic news feed was found            |
| `openai-agents-python`  | https://github.com/openai/openai-agents-python                   | github | ai-tooling | Agent framework with clean, low-noise version tags                    |
| `langgraph-releases`    | https://github.com/langchain-ai/langgraph                        | github | ai-tooling | Agent orchestration framework (per-package tags, noisy)               |
| `mcp-spec-releases`     | https://github.com/modelcontextprotocol/modelcontextprotocol     | github | ai-tooling | Model Context Protocol spec revisions; rare and high signal           |
| `nodejs-blog`           | https://nodejs.org/en/feed/blog.xml                              | rss    | platform   | Node.js release and security announcements                            |
| `typescript-releases`   | https://github.com/microsoft/TypeScript                          | github | platform   | TypeScript compiler releases                                          |
| `kubernetes-blog`       | https://kubernetes.io/feed.xml                                   | rss    | platform   | Official Kubernetes blog, including release announcements             |
| `docker-blog`           | https://www.docker.com/feed/                                     | rss    | platform   | Docker product, sandbox and security announcements                    |
| `terraform-releases`    | https://github.com/hashicorp/terraform                           | github | platform   | Terraform core releases                                               |
| `opentofu-releases`     | https://github.com/opentofu/opentofu                             | github | platform   | OpenTofu releases, the open Terraform fork                            |
| `github-changelog`      | https://github.blog/changelog/feed/                              | rss    | platform   | GitHub platform changelog (Actions, Copilot, security)                |
| `aws-whats-new`         | https://aws.amazon.com/about-aws/whats-new/recent/feed/          | rss    | cloud      | AWS launches; firehose, so capped with `maxItems: 40`                 |
| `gcp-release-notes`     | https://docs.cloud.google.com/feeds/gcp-release-notes.xml        | rss    | cloud      | Google Cloud release notes, one entry per day (Atom)                  |
| `azure-updates`         | https://www.microsoft.com/releasecommunications/api/v2/azure/rss | rss    | cloud      | Official Azure updates feed (launches, previews, retirements)         |

## Fetch limits

- A fetch follows a redirect only to the same host as the source URL (the apex and its `www.`
  count as one host; a GitHub source may also go to `api.github.com`). Any other target fails
  the source and the error names the host. A redirect from https to http is refused, and so is a
  chain of more than five. A response body over 5 MiB fails the source. `GITHUB_TOKEN` is never
  sent to another origin.
- A source URL may not contain a username or password. The config is rejected when it loads.
  Keep secrets in `.env`.
- A timeout, network error, 5xx, 408 or 429 is retried twice (after 0.5 s and 1 s). Any other
  answer fails the source at once. A failed source's error is cut to 300 characters in the run
  record.
- Each fetcher cuts its result to `maxItems` (else `maxItemsPerSource`), newest first.
- A source that yields no usable item is logged as a warning (`Source returned no usable
items`), not recorded in `run.json`.
- An `rss` entry with no text in the feed gets the first paragraphs of its own page, only from
  the feed's own host, 2 MiB at most, within 4 s per source.
- Entries of one feed that share a link (`gcp-release-notes`) each get their own URL by adding
  `?entry=<the entry's Atom id>`. The URL still opens the same page.
- Summaries are the fullest text of the entry with tags and scripts removed, cut to 600
  characters. An Atom link uses `rel="alternate"` and loses tracking parameters. `published`
  wins over `updated`; a date without a zone is read as UTC.

## Known limits of these feeds

- GitHub keeps 10 releases per Atom feed. A busy repo (`ollama`, `langgraph`, `vllm`) can push
  the oldest release of the week out of view. `github-changelog` returns only its newest 10.
- `aws-whats-new` publishes about 65 entries a week. The cap of `maxItems: 40` keeps the
  newest four days.
- There is no official Anthropic or Meta AI feed. Anthropic is covered by
  `claude-code-releases` only.
- Some sources overlap (`google-ai-blog` and `google-deepmind-blog`, `ollama-blog` and
  `ollama-releases`, `huggingface-blog` and `transformers-releases`). URL dedupe does not merge
  them. The process step drops the second item only when both name the same product and version.
