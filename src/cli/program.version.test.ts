import { readFileSync } from 'node:fs';
import type { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from './program';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

interface Outcome {
  readonly out: string;
  readonly code: string | undefined;
}

function parse(args: readonly string[]): Outcome {
  let out = '';
  const program = buildProgram(() => undefined)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        out += text;
      },
      writeErr: () => undefined,
    });
  try {
    program.parse(['node', 'digest', ...args], { from: 'node' });
  } catch (error) {
    return { out, code: (error as CommanderError).code };
  }
  return { out, code: undefined };
}

describe('CLI version flag', () => {
  it('prints the package.json version for --version', () => {
    expect(parse(['--version'])).toEqual({ out: `${version}\n`, code: 'commander.version' });
  });

  it('prints the same version for the short flag -V', () => {
    expect(parse(['-V'])).toEqual({ out: `${version}\n`, code: 'commander.version' });
  });

  it('lists the flag in the help text', () => {
    expect(parse(['--help']).out).toMatch(/-V, --version\s+output the version number/);
  });

  it('is a semantic version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
