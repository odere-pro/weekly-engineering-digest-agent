// Default allowlist, researched and verified live on 2026-10-16. Rationale, volumes and rejected
// candidates are in docs/sources.md. digest.config.example.json mirrors this list exactly.
import type { Source } from '../domain/schemas';

/** Areas used as classifier hints: ai-models, ai-tooling, platform, cloud. */
export const DEFAULT_SOURCES: readonly Source[] = [
  // AI labs and model releases
  { id: 'openai-news', kind: 'rss', url: 'https://openai.com/news/rss.xml', area: 'ai-models' },
  {
    id: 'google-deepmind-blog',
    kind: 'rss',
    url: 'https://deepmind.google/blog/rss.xml',
    area: 'ai-models',
  },
  {
    id: 'google-ai-blog',
    kind: 'rss',
    url: 'https://blog.google/innovation-and-ai/technology/ai/rss/',
    area: 'ai-models',
  },
  { id: 'mistral-news', kind: 'rss', url: 'https://mistral.ai/news/rss', area: 'ai-models' },
  {
    id: 'huggingface-blog',
    kind: 'rss',
    url: 'https://huggingface.co/blog/feed.xml',
    area: 'ai-models',
  },

  // AI tooling: frameworks, inference servers, agents, protocols
  { id: 'pytorch-blog', kind: 'rss', url: 'https://pytorch.org/blog/feed/', area: 'ai-tooling' },
  { id: 'ollama-blog', kind: 'rss', url: 'https://ollama.com/blog/rss.xml', area: 'ai-tooling' },
  {
    id: 'ollama-releases',
    kind: 'github',
    url: 'https://github.com/ollama/ollama',
    area: 'ai-tooling',
  },
  {
    id: 'vllm-releases',
    kind: 'github',
    url: 'https://github.com/vllm-project/vllm',
    area: 'ai-tooling',
  },
  {
    id: 'transformers-releases',
    kind: 'github',
    url: 'https://github.com/huggingface/transformers',
    area: 'ai-tooling',
  },
  {
    id: 'claude-code-releases',
    kind: 'github',
    url: 'https://github.com/anthropics/claude-code',
    area: 'ai-tooling',
  },
  {
    id: 'openai-agents-python',
    kind: 'github',
    url: 'https://github.com/openai/openai-agents-python',
    area: 'ai-tooling',
  },
  {
    id: 'langgraph-releases',
    kind: 'github',
    url: 'https://github.com/langchain-ai/langgraph',
    area: 'ai-tooling',
  },
  {
    id: 'mcp-spec-releases',
    kind: 'github',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
    area: 'ai-tooling',
  },

  // Developer platforms: runtimes, orchestration, infrastructure as code, CI
  { id: 'nodejs-blog', kind: 'rss', url: 'https://nodejs.org/en/feed/blog.xml', area: 'platform' },
  {
    id: 'typescript-releases',
    kind: 'github',
    url: 'https://github.com/microsoft/TypeScript',
    area: 'platform',
  },
  { id: 'kubernetes-blog', kind: 'rss', url: 'https://kubernetes.io/feed.xml', area: 'platform' },
  { id: 'docker-blog', kind: 'rss', url: 'https://www.docker.com/feed/', area: 'platform' },
  {
    id: 'terraform-releases',
    kind: 'github',
    url: 'https://github.com/hashicorp/terraform',
    area: 'platform',
  },
  {
    id: 'opentofu-releases',
    kind: 'github',
    url: 'https://github.com/opentofu/opentofu',
    area: 'platform',
  },
  {
    id: 'github-changelog',
    kind: 'rss',
    url: 'https://github.blog/changelog/feed/',
    area: 'platform',
  },

  // Cloud provider "what's new" feeds
  {
    id: 'aws-whats-new',
    kind: 'rss',
    url: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/',
    area: 'cloud',
    maxItems: 40,
  },
  {
    id: 'gcp-release-notes',
    kind: 'rss',
    url: 'https://docs.cloud.google.com/feeds/gcp-release-notes.xml',
    area: 'cloud',
  },
  {
    id: 'azure-updates',
    kind: 'rss',
    url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss',
    area: 'cloud',
  },
];

export const DEFAULT_FOCUS_AREAS: readonly string[] = [
  'AI models and tooling',
  'Platform engineering',
];
