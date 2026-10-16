// Entry point for `digest` (bundled to dist/cli.js).
import { buildProgram } from './program.js';

const program = buildProgram((code) => {
  process.exitCode = code;
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
