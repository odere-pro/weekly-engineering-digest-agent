import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_ALLOWED_HOSTS, isOutsideAllowlist } from './sourceAllowedHosts';

describe('SOURCE_ALLOWED_HOSTS', () => {
  it('lists the hosts docs/sources.md allows', async () => {
    const doc = await readFile(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'sources.md'),
      'utf8',
    );
    const line = doc.split('\n\n').find((p) => p.startsWith('Only these hosts are contacted'))!;
    const hosts = [...line.matchAll(/`([a-z0-9.-]+)`/g)].map((m) => m[1]);

    expect([...SOURCE_ALLOWED_HOSTS].sort()).toEqual([...hosts].sort());
  });
});

describe('isOutsideAllowlist', () => {
  it('lets an allowed host through', () => {
    expect(isOutsideAllowlist('https://openai.com/news/post-1')).toBe(false);
    expect(isOutsideAllowlist('https://github.com/ollama/ollama/releases/tag/v1')).toBe(false);
  });

  it('ignores a leading www and the case of the host', () => {
    expect(isOutsideAllowlist('https://www.openai.com/news')).toBe(false);
    expect(isOutsideAllowlist('https://WWW.Docker.com/blog')).toBe(false);
    expect(isOutsideAllowlist('https://docker.com/blog')).toBe(false);
  });

  it('flags a host that is not listed, subdomains of a listed host included', () => {
    expect(isOutsideAllowlist('https://evil.example.net/x')).toBe(true);
    expect(isOutsideAllowlist('https://news.openai.com/x')).toBe(true);
    expect(isOutsideAllowlist('https://openai.com.evil.example.net/x')).toBe(true);
  });

  it('flags a url that cannot be parsed', () => {
    expect(isOutsideAllowlist('not a url')).toBe(true);
    expect(isOutsideAllowlist('')).toBe(true);
  });
});
