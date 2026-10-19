import { resolveHostPlatform } from '../../config/load';
import type { ProfileName } from '../../config/schema';
import { ExitCode } from '../../domain/schemas';
import { DigestError, errorMessage } from '../../shared/errors';
import { buildConfigInput, toJson, validatedConfig } from './configFile/configFile';
import { buildEnvFile, secretsOf } from './envFile/envText';
import { confirmOverwrite } from './io/confirmOverwrite';
import { createDefaultIo } from './io/defaultIo';
import { isPromptCancelled } from './io/inquirerPrompts';
import { DEFAULT_CONFIG_PATH, DOCKERENV_PATH } from './paths';
import { askAnswers, defaultAnswers } from './prompts/answers';
import { localFolder } from './prompts/saveLocally';
import { scheduleSection } from './schedule/schedule';
import { dockerNextSteps, summary } from './summary/summary';
import type { Host, InitCommandOptions, InitIo } from './types';

const OLLAMA_PORT = 11434;

/**
 * `light` until `quality` has a measured baseline, whatever the RAM. The schema default stays
 * `quality`; this only decides what `digest init` suggests and writes with --yes.
 */
export function recommendProfile(): ProfileName {
  return 'light';
}

/**
 * Where Ollama is reachable from here. Inside Docker on a Mac the Apple GPU is only available to
 * the Ollama app on the host; inside Docker elsewhere the compose `ollama` service is used.
 */
export function resolveOllamaUrl(mode: { inDocker: boolean; hostOs: string | undefined }): string {
  if (!mode.inDocker) return `http://localhost:${String(OLLAMA_PORT)}`;
  const host = mode.hostOs === 'darwin' ? 'host.docker.internal' : 'ollama';
  return `http://${host}:${String(OLLAMA_PORT)}`;
}

/** `digest init`: Asks for focus areas, delivery and profile, then writes digest.config.json and .env. Returns the process exit code. */
export async function initCommand(
  options: InitCommandOptions,
  overrides: Partial<InitIo> = {},
): Promise<number> {
  const io: InitIo = { ...createDefaultIo(), ...overrides };
  try {
    return await runInit(options, io);
  } catch (error) {
    if (isPromptCancelled(error)) {
      io.stderr('Cancelled. Nothing was written.\n');
      return ExitCode.Failed;
    }
    if (!(error instanceof DigestError)) throw error;
    io.stderr(`${error.message}\n`);
    return error.exitCode;
  }
}

/**
 * The steps in order. The overwrite check, the answers, the config schema, the secrets and the
 * merge into an existing .env all run before the first write; only the two writes (config, then
 * .env) can still fail after that.
 */
async function runInit(options: InitCommandOptions, io: InitIo): Promise<number> {
  const configPath = options.config ?? DEFAULT_CONFIG_PATH;
  // Only the config is replaced; .env is merged into, so it needs no confirmation.
  await confirmOverwrite([configPath], options.yes === true, io);

  const inDocker = await io.exists(DOCKERENV_PATH);
  const host: Host = { inDocker, hostOs: namedHostOs(io, inDocker) };
  const recommended = recommendProfile();
  const answers =
    options.yes === true
      ? defaultAnswers(io, recommended)
      : await askAnswers(io, host, recommended);
  const configInput = buildConfigInput(answers);
  const config = validatedConfig(configInput);
  const ollamaUrl = resolveOllamaUrl(host);
  const envFile = await buildEnvFile(io, ollamaUrl, secretsOf(answers));

  await writeOrFail(configPath, () => io.writeFile(configPath, toJson(configInput)));
  await writeOrFail(io.envPath, () => io.writeSecretFile(io.envPath, envFile.text));

  io.stdout(
    summary({
      configPath,
      envPath: io.envPath,
      answers,
      ollamaUrl,
      envMerged: envFile.merged,
      localFolder: localFolder(io, {
        timeZone: answers.timeZone,
        inDocker,
        dataDir: config.dataDir,
      }),
    }),
  );
  io.stdout(
    inDocker
      ? dockerNextSteps(answers.timeZone)
      : scheduleSection(io, configPath, config.schedule.cron),
  );
  return ExitCode.Sent;
}

/**
 * The OS Ollama runs on, spelled as the loader reads it (`Darwin` from `uname -s` is a Mac too).
 * Only a container needs it, so a bad value elsewhere is left for the loader to report.
 */
function namedHostOs(io: InitIo, inDocker: boolean): string | undefined {
  const named = io.env['DIGEST_HOST_OS'];
  if (!inDocker || named === undefined || named.trim() === '') return undefined;
  return resolveHostPlatform({ DIGEST_HOST_OS: named }).os;
}

async function writeOrFail(path: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new DigestError(`Could not write ${path}: ${errorMessage(error)}`, { cause: error });
  }
}
