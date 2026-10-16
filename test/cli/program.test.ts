import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

describe('CLI program', () => {
  it('registers every spec command', () => {
    const names = buildProgram(() => undefined).commands.map((c) => c.name());
    expect(names).toEqual(['init', 'doctor', 'run', 'eval', 'history', 'serve']);
  });

  it('passes the global --config and command flags to the handler', async () => {
    const codes: number[] = [];
    const program = buildProgram((code) => codes.push(code)).exitOverride();
    // Stubs throw NotImplementedError until their issue lands.
    await expect(
      program.parseAsync(['node', 'digest', '--config', 'x.json', 'run', '--dry-run'], {
        from: 'node',
      }),
    ).rejects.toThrow('W1-17');
    expect(codes).toEqual([]);
  });

  it('rejects a non-numeric --limit', async () => {
    const program = buildProgram(() => undefined).exitOverride();
    for (const command of program.commands)
      command.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(
      program.parseAsync(['node', 'digest', 'history', '--limit', 'x']),
    ).rejects.toThrow();
  });
});
