// Bundles the CLI into one ESM file. Dependencies stay external for the npm package.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
