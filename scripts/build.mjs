// Bundles the CLI into one ESM file, dist/artifacts/cli.js: build output goes to dist/artifacts,
// next to (never mixed with) the runs, fetched data and logs below dist/. Dependencies stay
// external for the npm package.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/artifacts/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
