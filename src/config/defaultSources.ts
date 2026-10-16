// Placeholder allowlist. Owned by issue W1-21, which replaces it with the researched list.
import type { Source } from '../core/schemas.js';

export const DEFAULT_SOURCES: readonly Source[] = [
  { id: 'nodejs-releases', kind: 'github', url: 'https://github.com/nodejs/node' },
  { id: 'kubernetes-blog', kind: 'rss', url: 'https://kubernetes.io/feed.xml' },
];

export const DEFAULT_FOCUS_AREAS: readonly string[] = [
  'AI models and tooling',
  'Platform engineering',
];
