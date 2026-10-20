import { constants, type Stats } from 'node:fs';
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { createModelProvider } from '../../app/container';
import { loadConfig, platformOf, type LoadedConfig } from '../../config/load';
import type { Platform } from '../../config/profiles';
import { systemClock } from '../../shared/clock';
import { errorMessage } from '../../shared/errors';
import { noopLogger } from '../../shared/telemetry';
import { checkDelivery } from './checks/delivery';
import { checkAppleSilicon, checkOllama } from './checks/host';
import { checkGuards } from './checks/guards';
import { checkModels, checkThink } from './checks/models';
import { checkSchedule } from './checks/schedule';
import { checkSources, SOURCE_TIMEOUT_MS } from './checks/sources';
import { checkUnknownKeys } from './checks/unknownKeys';
import { checkEnvFile, checkEnvValues } from './envFile/envFile';
import { checkWritableDir, dataDirCheck } from './folders/writableDir';
import { readinessCommand } from './readiness/readiness';
import { fail, ok, type CheckResult } from './report/checkResult';
import { report } from './report/report';
import type { DoctorIo, PathInfo } from './types';

export interface DoctorCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Print the machine summary and a verdict per profile instead of the checks. */
  readiness?: boolean;
}

const defaultIo: DoctorIo = {
  loadConfig: (options) => loadConfig(options),
  createProvider: (loaded, fetchImpl) =>
    createModelProvider(loaded, { logger: noopLogger, fetch: fetchImpl }),
  fetch: (input, init) => globalThis.fetch(input, init),
  clock: systemClock,
  envPath: '.env',
  stat: async (path) => toPathInfo(await stat(path)),
  lstat: async (path) => toPathInfo(await lstat(path)),
  readFile: (path) => readFile(path, 'utf8'),
  access: (path) => access(path, constants.W_OK),
  sourceTimeoutMs: SOURCE_TIMEOUT_MS,
  stdout: (text) => {
    process.stdout.write(text);
  },
};

function toPathInfo(stats: Stats): PathInfo {
  return {
    mode: stats.mode,
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

/** `digest doctor`: Checks Ollama, the models, every feed and delivery; prints what to fix (W1-19). Returns the process exit code. */
export async function doctorCommand(
  options: DoctorCommandOptions,
  overrides: Partial<DoctorIo> = {},
): Promise<number> {
  const io: DoctorIo = { ...defaultIo, ...overrides };
  if (options.readiness) return runReadiness(options, io);
  const loaded = await tryLoadConfig(options, io);
  if ('result' in loaded) return report([loaded.result], io.stdout, {});

  const { config, profile } = loaded.value;
  const health = await io.createProvider(loaded.value, io.fetch).health();
  const results: CheckResult[] = [
    ok('config', `loaded ${loaded.value.configPath} (profile ${config.profile})`),
    ...(await checkUnknownKeys(loaded.value.configPath, io)),
    ...checkOllama(health, loaded.value),
    // The platform the loader resolved the profile for, so the checks judge the same host.
    checkAppleSilicon(loaded.value, loaded.platform),
    ...checkModels(health, profile, config.guards),
    checkThink(loaded.value),
    ...(await checkSources(loaded.value, io)),
    ...(await checkDelivery(loaded.value, io)),
    await checkEnvFile(io),
    ...(await checkEnvValues(io)),
    checkGuards(config.guards),
    checkSchedule(config.schedule, io.clock),
    await checkWritableDir(dataDirCheck(config.dataDir), io),
  ];
  return report(results, io.stdout, loaded.value.secrets);
}

function runReadiness(options: DoctorCommandOptions, io: DoctorIo): Promise<number> {
  return readinessCommand(
    { config: options.config },
    {
      loadConfig: io.loadConfig,
      envPath: io.envPath,
      stdout: io.stdout,
      ...(io.platform ? { platform: io.platform } : {}),
      ...io.readiness,
    },
  );
}

/** `platform` is the host the loader resolved the profile for (a bad DIGEST_HOST_* is reported here). */
async function tryLoadConfig(
  options: DoctorCommandOptions,
  io: DoctorIo,
): Promise<{ value: LoadedConfig; platform: Platform } | { result: CheckResult }> {
  try {
    const value = await io.loadConfig({
      configPath: options.config,
      envPath: io.envPath,
      platform: io.platform,
    });
    return { value, platform: platformOf(value) };
  } catch (error) {
    return {
      result: fail(
        'config',
        errorMessage(error),
        'fix the file or variable named above, or run "digest init" to create a config',
      ),
    };
  }
}
