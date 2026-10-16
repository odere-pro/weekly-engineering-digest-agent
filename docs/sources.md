# Default source allowlist

The 24 feeds in `DEFAULT_SOURCES` ([`src/config/defaultSources.ts`](../src/config/defaultSources.ts)),
mirrored in [`digest.config.example.json`](../digest.config.example.json). A test keeps the two,
and this file, in sync.

Only these hosts are contacted at collection time: `openai.com`, `deepmind.google`,
`blog.google`, `mistral.ai`, `huggingface.co`, `pytorch.org`, `ollama.com`, `github.com`,
`nodejs.org`, `kubernetes.io`, `www.docker.com`, `github.blog`, `aws.amazon.com`,
`docs.cloud.google.com`, `www.microsoft.com`.

With `GITHUB_TOKEN` set, the GitHub fetcher also calls `api.github.com` (REST mode).

## How each feed was checked

On **2026-10-16** every URL below was fetched live (GET, redirects followed, 20 s timeout) and
checked for HTTP 200, a body that parses as RSS or Atom, and at least one entry dated in the
last 90 days. Every feed answered directly, with no redirect, in under 2 s. For `github` sources
the feed checked was `<repo>/releases.atom`, which the fetcher reads without a token. "Last 7 d
/ 90 d" counts entries in that window; `+` means the feed returned all its entries inside the
window, so the real count is at least that.

## Sources

Areas are classifier hints: `ai-models` (labs and model releases), `ai-tooling` (inference,
frameworks, agents, protocols), `platform` (runtimes, orchestration, IaC, CI), `cloud` (provider
"what's new").

| id                      | URL                                                              | kind   | area       | why it is in                                                          | last 7 d / 90 d | verified   |
| ----------------------- | ---------------------------------------------------------------- | ------ | ---------- | --------------------------------------------------------------------- | --------------- | ---------- |
| `openai-news`           | https://openai.com/news/rss.xml                                  | rss    | ai-models  | OpenAI's official news: model, API and product launches               | 9 / 180         | 2026-10-16 |
| `google-deepmind-blog`  | https://deepmind.google/blog/rss.xml                             | rss    | ai-models  | Google DeepMind research and Gemini model announcements               | 5 / 29          | 2026-10-16 |
| `google-ai-blog`        | https://blog.google/innovation-and-ai/technology/ai/rss/         | rss    | ai-models  | Google's product-side AI announcements (Gemini, tooling)              | 1 / 20+         | 2026-10-16 |
| `mistral-news`          | https://mistral.ai/news/rss                                      | rss    | ai-models  | Mistral model and platform news                                       | 1 / 11          | 2026-10-16 |
| `huggingface-blog`      | https://huggingface.co/blog/feed.xml                             | rss    | ai-models  | Open-model releases and ecosystem changes                             | 7 / 53          | 2026-10-16 |
| `pytorch-blog`          | https://pytorch.org/blog/feed/                                   | rss    | ai-tooling | PyTorch release and ecosystem posts (the repo's releases are CI tags) | 3 / 10+         | 2026-10-16 |
| `ollama-blog`           | https://ollama.com/blog/rss.xml                                  | rss    | ai-tooling | Ollama feature and model-availability posts; this agent runs on it    | 2 / 7           | 2026-10-16 |
| `ollama-releases`       | https://github.com/ollama/ollama                                 | github | ai-tooling | Ollama runtime releases                                               | 10+ / 10+       | 2026-10-16 |
| `vllm-releases`         | https://github.com/vllm-project/vllm                             | github | ai-tooling | Main open-source LLM inference server                                 | 4 / 10+         | 2026-10-16 |
| `transformers-releases` | https://github.com/huggingface/transformers                      | github | ai-tooling | Reference library for new open model architectures                    | 2 / 9           | 2026-10-16 |
| `claude-code-releases`  | https://github.com/anthropics/claude-code                        | github | ai-tooling | Anthropic's coding agent; no Anthropic news feed was found            | 4 / 10+         | 2026-10-16 |
| `openai-agents-python`  | https://github.com/openai/openai-agents-python                   | github | ai-tooling | Agent framework with clean, low-noise version tags                    | 1 / 10+         | 2026-10-16 |
| `langgraph-releases`    | https://github.com/langchain-ai/langgraph                        | github | ai-tooling | Agent orchestration framework (per-package tags, noisy)               | 9 / 10+         | 2026-10-16 |
| `mcp-spec-releases`     | https://github.com/modelcontextprotocol/modelcontextprotocol     | github | ai-tooling | Model Context Protocol spec revisions; rare and high signal           | 0 / 2           | 2026-10-16 |
| `nodejs-blog`           | https://nodejs.org/en/feed/blog.xml                              | rss    | platform   | Node.js release and security announcements                            | 3 / 22          | 2026-10-16 |
| `typescript-releases`   | https://github.com/microsoft/TypeScript                          | github | platform   | TypeScript compiler releases                                          | 0 / 3           | 2026-10-16 |
| `kubernetes-blog`       | https://kubernetes.io/feed.xml                                   | rss    | platform   | Official Kubernetes blog, including release announcements             | 1 / 25          | 2026-10-16 |
| `docker-blog`           | https://www.docker.com/feed/                                     | rss    | platform   | Docker product, sandbox and security announcements                    | 3 / 10+         | 2026-10-16 |
| `terraform-releases`    | https://github.com/hashicorp/terraform                           | github | platform   | Terraform core releases                                               | 2 / 10+         | 2026-10-16 |
| `opentofu-releases`     | https://github.com/opentofu/opentofu                             | github | platform   | OpenTofu releases, the open Terraform fork                            | 1 / 10+         | 2026-10-16 |
| `github-changelog`      | https://github.blog/changelog/feed/                              | rss    | platform   | GitHub platform changelog (Actions, Copilot, security)                | 10+ / 10+       | 2026-10-16 |
| `aws-whats-new`         | https://aws.amazon.com/about-aws/whats-new/recent/feed/          | rss    | cloud      | AWS launches; firehose, so capped with `maxItems: 40`                 | 65 / 100+       | 2026-10-16 |
| `gcp-release-notes`     | https://docs.cloud.google.com/feeds/gcp-release-notes.xml        | rss    | cloud      | Google Cloud release notes, one entry per day (Atom)                  | 6 / 30+         | 2026-10-16 |
| `azure-updates`         | https://www.microsoft.com/releasecommunications/api/v2/azure/rss | rss    | cloud      | Official Azure updates feed (launches, previews, retirements)         | 6 / 187         | 2026-10-16 |

## Known limits of these feeds

- **GitHub keeps 10 releases per Atom feed.** Repos that tag several times a week (`ollama`,
  `langgraph`, `vllm`) can push the oldest in-window release out of view in a busy week;
  `ollama-releases` already fills all 10 entries within 7 days. The token-based REST mode was
  not checked here.
- **`github-changelog` returns only 10 entries, all from the last 7 days,** so a busy week is
  truncated at the feed. There is no larger official feed.
- **`aws-whats-new` publishes about 65 entries a week** (about 9 a day), mostly region
  expansions. The default cap of 20 reaches back about two days, `maxItems: 40` about four.
  This deliberate cut keeps the newest items: raise it to 100 for the whole week, or lower it
  if classification is slow on your machine.
- **`gcp-release-notes` entries are one day of notes for every product.** They are long and the
  fetcher truncates the summary, so the classifier sees only the start of each.
- **No official Anthropic or Meta AI feed was found** (every URL tried returned 404; see the
  rejected list). Anthropic is covered by `claude-code-releases` only.
- **Some sources overlap** (`google-ai-blog` and `google-deepmind-blog`, `ollama-blog` and
  `ollama-releases`, `huggingface-blog` and `transformers-releases`). The same story can arrive
  under two URLs; URL dedupe does not merge them, so the select step may see both.

## Verified but not included

These answered correctly on 2026-10-16 and are the first candidates to add, if wanted:
`run-llama/llama_index` (v0.14.x, 2 releases in 90 d), `crewAIInc/crewAI`, `sgl-project/sglang`,
`argoproj/argo-cd` (duplicate tags per release), `helm/helm`, `prometheus/prometheus`
(two tags per release), `istio/istio`, `cilium/cilium`, `oven-sh/bun`, `denoland/deno`,
`blog.rust-lang.org/feed.xml`, `go.dev/blog/feed.atom`, `blog.cloudflare.com/rss/`,
`www.cncf.io/feed/`, `grafana.com/blog/index.xml`,
`aws.amazon.com/blogs/machine-learning/feed/`, `aws.amazon.com/blogs/containers/feed/`.
They were left out because they overlap an included source, are language or vendor blogs
rather than releases, or add volume without adding the releases this digest is about.

## Rejected candidates

| Candidate                                                                     | Result (2026-10-16)                                | Why rejected                                                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `anthropic.com/news/rss.xml`, `/rss.xml`, `/feed.xml`, `/engineering/rss.xml` | 404 on all four                                    | No official feed; community mirrors are third parties, off the allowlist                |
| `anthropics/anthropic-sdk-typescript`, `anthropic-sdk-python`                 | Atom OK, 8 and 3 releases in 7 d                   | SDK version bumps rather than model news; left out to limit noise                       |
| `ai.meta.com/blog/rss/`                                                       | 404                                                | No official feed                                                                        |
| `mistral.ai/news/rss.xml`, `/feed.xml`                                        | 404 (the working URL is `/news/rss`, the one used) | Wrong URL                                                                               |
| `mistralai/mistral-inference` releases                                        | Atom OK, newest 2025-03-20                         | Stale: nothing in the last 90 days                                                      |
| `huggingface/text-generation-inference` releases                              | Atom OK, newest 2025-12-19                         | Stale: nothing in the last 90 days                                                      |
| `blog.langchain.com/rss/`                                                     | 200 but redirects to an HTML page, 0 entries       | Not a feed                                                                              |
| `www.langchain.com/blog/rss.xml`                                              | RSS OK, 15 entries in 7 d                          | Marketing-heavy volume; `langgraph-releases` carries the releases                       |
| `pytorch/pytorch` releases                                                    | Atom OK                                            | Entries are `viable/strict/<timestamp>` CI tags, not releases                           |
| `pytorch.org/blog/feed.xml`, `/rss.xml`, `/atom.xml`                          | 404 on all three                                   | Wrong URL; `/blog/feed/` is the working one                                             |
| `ggml-org/llama.cpp` releases                                                 | Atom OK                                            | One tag per CI build (`b11696`, `b11695`, ...), hours apart; pure noise                 |
| `vercel/ai`, `mastra-ai/mastra` releases                                      | Atom OK, 10 of 10 entries in 7 d                   | Per-package tags (`@ai-sdk/zai@3.0.32`) fill the 10-entry window and hide real releases |
| `developer.nvidia.com/blog/feed`                                              | Atom OK, 31 entries in 7 d                         | Mostly vendor how-tos and marketing; would flood classification                         |
| `ollama.com/blog/rss`, `blog.vllm.ai/feed.xml`, `lmstudio.ai/blog/rss.xml`    | 404                                                | Wrong URL or no feed                                                                    |
| `devblogs.microsoft.com/typescript/feed/`                                     | RSS OK, newest post 2026-07-08                     | No post in the last 90 days; `typescript-releases` covers it                            |
| `nodejs/node` releases and `nodejs.org/en/feed/releases.xml`                  | Both OK                                            | Same release posts as `nodejs-blog`; would duplicate items                              |
| `kubernetes/kubernetes` releases                                              | Atom OK, newest `v1.38.0-alpha.2`                  | Alpha and pre-release tags; the blog carries release announcements                      |
| `azure.microsoft.com/en-us/updates/feed/`                                     | 200 but redirects to an HTML page, 0 entries       | Not a feed; replaced by the `releasecommunications` API feed                            |
| `pythoninsider.blogspot.com/feeds/posts/default`                              | Atom OK, newest 2026-03-03                         | Stale: nothing in the last 90 days                                                      |
| `open-telemetry/opentelemetry-collector` releases                             | Atom OK, 10 of 10 entries in 7 d                   | Per-module tags (`service/v0.163.0`) saturate the 10-entry window                       |
| `hashicorp.com/blog/feed.xml`                                                 | Atom OK                                            | Product marketing mixed with Terraform posts; releases come via GitHub                  |

Replaced from the previous placeholder: `nodejs-releases` (GitHub `nodejs/node`) is now
`nodejs-blog`. `kubernetes-blog` is unchanged.
