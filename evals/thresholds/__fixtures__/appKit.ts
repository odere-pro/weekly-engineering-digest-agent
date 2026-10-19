// A fake app for the capture session: the light profile on a fake model whose health the test sets.
import type { AppHandle } from '../../../src/app/container';
import type { LoadedConfig } from '../../../src/config/load';
import { PROFILES, resolveProfile, type Platform } from '../../../src/config/profiles';
import { EnvSchema, SecretsSchema } from '../../../src/config/schema';
import type { DigestDeps } from '../../../src/digest/runDigest';
import type { GuardCheckId } from '../../../src/guards/guardVerdict';
import type { ModelHealth } from '../../../src/models/ModelProvider';
import { fixedClock } from '../../../src/shared/clock';
import { noopLogger, noopTracer } from '../../../src/shared/telemetry';
import { makeConfig } from '../../../test/builders';
import {
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  MemoryRunStore,
} from '../../../test/fakes';

export const installed = (...names: string[]) => names.map((name) => ({ name, capabilities: [] }));
/** The two tags the light profile needs from Ollama (the decider also guards policy). */
export const lightModels = [PROFILES.light.classify, PROFILES.light.guardRisk];

/** What `loadConfig` returns for the default test config on an Apple-silicon Mac. */
export function loadedConfig(): LoadedConfig {
  const config = makeConfig();
  const platform: Platform = { os: 'darwin', arch: 'arm64' };
  return {
    config,
    env: EnvSchema.parse({}),
    secrets: SecretsSchema.parse({}),
    profile: resolveProfile(config.profile, platform, config.models.writers),
    platform,
    configPath: '/project/digest.config.json',
  };
}

/** An app handle that counts how often it is closed. */
export function fakeApp(
  health: ModelHealth,
  inputGuards: readonly GuardCheckId[] = ['clefPolicy', 'graniteRisk'],
  outputGuards: readonly GuardCheckId[] = ['graniteGroundedness', 'clefRubric'],
) {
  const model = new FakeModelProvider({ health });
  let closed = 0;
  const deps = {
    config: makeConfig(),
    profile: PROFILES.light,
    model,
    fetchers: {},
    inputGuards: inputGuards.map((id) => new FakeInputGuard(id)),
    outputGuards: outputGuards.map((id) => new FakeOutputGuard(id)),
    deliveries: [],
    store: new MemoryRunStore(),
    logger: noopLogger,
    clock: fixedClock('2026-10-17T10:00:00Z'),
    tracer: noopTracer,
  } satisfies DigestDeps;
  const handle: AppHandle = {
    deps,
    close: () => {
      closed += 1;
      return Promise.resolve();
    },
  };
  return { handle, closed: () => closed };
}
