import type { ModelProvider } from '../ModelProvider';
import { generate, type ChatOptions } from './chat/generate';
import { decide } from './decide/decide';
import { health } from './health/health';
import { createLoadTracker } from './call/loadTracker';
import { createOllamaHttp } from './ollamaHttp';

/** What `createOllamaProvider` takes: the server, then the options the three calls read. */
export interface OllamaProviderOptions extends ChatOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

/** ModelProvider on Ollama: /api/chat for generate, /v1/systemone for decide (W1-04). */
export function createOllamaProvider(options: OllamaProviderOptions): ModelProvider {
  const context = {
    http: createOllamaHttp(options.baseUrl, options.fetch ?? globalThis.fetch),
    options,
    loads: createLoadTracker(),
  };
  return {
    generate: (request) => generate(context, request),
    decide: (request) => decide(context, request),
    health: () => health(context.http),
  };
}
