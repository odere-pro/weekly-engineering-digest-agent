import { createOllamaProvider } from '../../../src/models/adapters/ollama';
import type { Role } from '../../../src/models/roles';
import { fakeOllama, type FakeOllama, type OllamaCall, type OllamaRoute } from '../fakeOllama';
import { OLLAMA_URL, PROFILE } from './constants';
import { createWorld, type World, type WorldOptions } from './world';

export interface OllamaWorldOptions extends Omit<WorldOptions, 'model'> {
  /** Answers /api/chat; `validReply` builds the valid digest JSON for a write prompt. */
  chat?: (call: OllamaCall, validReply: (prompt: string) => string) => Response | Promise<Response>;
  systemone?: OllamaRoute;
  /** Tags /api/tags lists; default is every model of the profile. */
  models?: readonly string[];
  /** An Ollama that refuses every connection. */
  down?: Error;
  /** Per-attempt timeouts of the real adapter, in ms. */
  timeoutsMs?: Partial<Record<Role, number>>;
  retries?: number;
  /** Cold-start allowance of the real adapter, in ms. 0 by default, so a timeout test stays short. */
  coldStartMs?: number;
  /**
   * The real adapter serves generate and health; decisions stay on the fake model (default).
   * Set false to send decisions to the scripted /v1/systemone as well.
   */
  decideOnFake?: boolean;
}

/** A world whose model is the real Ollama adapter, talking to a scripted Ollama. */
export function createOllamaWorld(options: OllamaWorldOptions): {
  world: World;
  ollama: FakeOllama;
} {
  const {
    chat,
    systemone,
    models,
    down,
    timeoutsMs,
    retries,
    coldStartMs = 0,
    decideOnFake = true,
    ...worldOptions
  } = options;
  let ollama: FakeOllama | undefined;
  const world = createWorld({
    ...worldOptions,
    model: ({ fake, logger, validReply }) => {
      ollama = fakeOllama({
        down,
        models,
        systemone,
        chat: chat && ((call) => chat(call, validReply)),
      });
      const real = createOllamaProvider({
        baseUrl: OLLAMA_URL,
        profile: PROFILE,
        fetch: ollama.fetch,
        timeoutsMs,
        retries,
        coldStartMs,
        logger,
      });
      if (!decideOnFake) return real;
      return {
        generate: (request) => real.generate(request),
        health: () => real.health(),
        decide: (request) => fake.decide(request),
      };
    },
  });
  if (!ollama) throw new Error('createWorld did not build the model');
  return { world, ollama };
}
