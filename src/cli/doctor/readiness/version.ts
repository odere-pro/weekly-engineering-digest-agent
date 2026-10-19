// Ollama versions and model tags, shared by the doctor checks and the readiness table.

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/;
/** Ollama builds from source (and some test builds) report this. */
export const DEVELOPMENT_VERSION = [0, 0, 0] as const;

export type Core = readonly [number, number, number];
export interface Version {
  core: Core;
  /** "-rc1", "-dev": semver puts it below the release of the same number. */
  prerelease: boolean;
}

export function parseVersion(text: string): Version | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) return undefined;
  const [, major = '0', minor = '0', patch = '0', rest = ''] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: rest.startsWith('-') || /^[a-z]/i.test(rest),
  };
}

export function compareCore(a: Core, b: Core): number {
  const index = a.findIndex((part, i) => part !== b[i]);
  return index < 0 ? 0 : (a[index] ?? 0) - (b[index] ?? 0);
}

/** Ollama lists an untagged name as ":latest". */
export function normalizeTag(tag: string): string {
  const name = tag.slice(tag.lastIndexOf('/') + 1); // a registry port ("host:5000/x") is not a version
  return name.includes(':') ? tag : `${tag}:latest`;
}
