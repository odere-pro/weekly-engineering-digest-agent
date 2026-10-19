/** The hosts docs/sources.md says are contacted; `sourceAllowedHosts.test.ts` keeps them in sync. */
export const SOURCE_ALLOWED_HOSTS: readonly string[] = [
  'openai.com',
  'deepmind.google',
  'blog.google',
  'mistral.ai',
  'huggingface.co',
  'pytorch.org',
  'ollama.com',
  'github.com',
  'nodejs.org',
  'kubernetes.io',
  'www.docker.com',
  'github.blog',
  'aws.amazon.com',
  'docs.cloud.google.com',
  'www.microsoft.com',
];

const withoutWww = (host: string): string => host.toLowerCase().replace(/^www\./, '');
const ALLOWED = new Set(SOURCE_ALLOWED_HOSTS.map(withoutWww));

/** True when the URL's host is not allowed, or the URL cannot be read. */
export function isOutsideAllowlist(url: string): boolean {
  try {
    return !ALLOWED.has(withoutWww(new URL(url).hostname));
  } catch {
    return true;
  }
}
