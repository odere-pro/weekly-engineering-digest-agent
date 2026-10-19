import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/schema';

const ROOT = new URL('../../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, ROOT), 'utf8');

/** Where the container sees the default data folder: the image's WORKDIR plus the config default. */
const APP_DIR = '/app';
const DATA_DIR = '/app/dist';
/** The program sits outside /app/dist, so the bind mount over /app/dist cannot hide it. */
const CLI = '/opt/eng-digest/dist/artifacts/cli.js';

describe('Docker: where everything the app produces goes', () => {
  it('has the default data folder at /app/dist, under the image WORKDIR', () => {
    const config = ConfigSchema.parse({
      focusAreas: ['a'],
      sources: [{ id: 'x', kind: 'rss', url: 'https://example.com/feed' }],
    });
    expect(posix.join(APP_DIR, config.dataDir)).toBe(DATA_DIR);
    expect(config.delivery.markdown.dir).toBeUndefined();
    expect(read('Dockerfile')).toMatch(/^WORKDIR \/app$/m);
  });

  it('mounts ./dist at the data folder, so runs, fetched data and logs reach the host', () => {
    const compose = read('docker-compose.yml');

    expect(compose).toMatch(/^\s+- \.\/dist:\/app\/dist$/m);
    expect(compose).not.toMatch(/\.\/data/);
  });

  it('runs the CLI from outside the mounted folder', () => {
    const dockerfile = read('Dockerfile');

    expect(dockerfile).toContain(`ENTRYPOINT ["node", "${CLI}"]`);
    expect(dockerfile).toContain('COPY --from=build /app/dist/artifacts ./dist/artifacts');
  });

  it('creates the data folder in the image for the non-root user, for a run without Compose', () => {
    const dockerfile = read('Dockerfile');

    expect(dockerfile).toMatch(/mkdir -p \/app\/dist && chown node:node \/app\/dist/);
  });

  it('checks the mount and the folder in docker/validate.sh', () => {
    const script = read('docker/validate.sh');

    expect(script).toContain('target: /app/dist');
    expect(script).toContain('test -w /app/dist');
  });
});
