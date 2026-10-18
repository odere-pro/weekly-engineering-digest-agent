import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../builders.js';

const ROOT = new URL('../../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, ROOT), 'utf8');

/** Where the container sees the default digest folder: the image's WORKDIR plus the config default. */
const APP_DIR = '/app';
const DEFAULT_DIGEST_DIR = '/app/dist/digests';

describe('Docker: where the digest files go', () => {
  it('has the default digest folder at /app/dist/digests, under the image WORKDIR', () => {
    const dir = makeConfig().delivery.markdown.dir;

    expect(posix.join(APP_DIR, dir)).toBe(DEFAULT_DIGEST_DIR);
    expect(read('Dockerfile')).toMatch(/^WORKDIR \/app$/m);
  });

  it('mounts ./data/digests at the default digest folder, so the files reach the host', () => {
    const compose = read('docker-compose.yml');

    expect(compose).toMatch(/^\s+- \.\/data\/digests:\/app\/dist\/digests$/m);
    expect(compose).toMatch(/^\s+- \.\/data:\/app\/data$/m);
  });

  it('creates the folder in the image for the non-root user, for a run without Compose', () => {
    const dockerfile = read('Dockerfile');

    expect(dockerfile).toMatch(/mkdir -p [^\n]*\/app\/dist\/digests/);
    expect(dockerfile).toMatch(/chown node:node [^\n]*\/app\/dist\/digests/);
    expect(dockerfile.indexOf('/app/dist/digests')).toBeGreaterThan(
      dockerfile.indexOf('COPY --from=build /app/dist ./dist'),
    );
  });

  it('checks the mount and the folder in docker/validate.sh', () => {
    const script = read('docker/validate.sh');

    expect(script).toContain('target: /app/dist/digests');
    expect(script).toContain('test -w /app/dist/digests');
  });
});
