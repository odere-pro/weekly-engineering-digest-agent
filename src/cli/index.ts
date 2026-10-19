// Entry point for `digest` (bundled to dist/artifacts/cli.js).
import { buildProgram } from './program';

const program = buildProgram((code) => {
  process.exitCode = code;
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
