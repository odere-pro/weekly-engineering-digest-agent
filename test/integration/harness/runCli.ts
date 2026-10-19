import { join } from 'node:path';
import type { AppHandle } from '../../../src/app/container';
import { runCommand, type RunCommandOptions } from '../../../src/cli/run/run';
import { OLLAMA_URL, PROFILE } from './constants';
import type { World } from './world';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `digest run` over the world's deps, with the real runDigest, for the exit code and the message. */
export async function runCli(world: World, options: RunCommandOptions = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const app: AppHandle = { deps: world.deps, close: () => Promise.resolve() };
  const exitCode = await runCommand(options, {
    loadConfig: () =>
      Promise.resolve({
        config: world.deps.config,
        env: { OLLAMA_URL, LOG_LEVEL: 'info' },
        secrets: {},
        profile: PROFILE,
        platform: { os: 'darwin', arch: 'arm64' },
        configPath: join(world.dataDir, 'digest.config.json'),
      }),
    buildApp: () => Promise.resolve(app),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}
