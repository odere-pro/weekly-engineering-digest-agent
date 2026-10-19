import { z } from 'zod';
import { errorMessage } from '../../../shared/errors';
import { TimeoutError, withTimeout } from '../../../shared/retry';
import type { ModelHealth } from '../../ModelProvider';
import {
  OllamaNetworkError,
  parseOllamaResponse,
  unreachableMessage,
  type OllamaHttp,
} from '../ollamaHttp';

const HEALTH_TIMEOUT_MS = 5_000;
const VERSION_PATH = '/api/version';
const TAGS_PATH = '/api/tags';

const VersionSchema = z.object({ version: z.string() });
const TagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), capabilities: z.array(z.string()).optional() })),
});

async function getParsed<T>(http: OllamaHttp, path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await withTimeout((signal) => http.get(path, signal), HEALTH_TIMEOUT_MS);
  return parseOllamaResponse(schema, raw, path);
}

function healthError(error: unknown, baseUrl: string): string {
  if (error instanceof OllamaNetworkError && error.unreachable) return unreachableMessage(baseUrl);
  if (error instanceof TimeoutError)
    return `Ollama at ${baseUrl} did not answer within ${HEALTH_TIMEOUT_MS} ms`;
  return errorMessage(error);
}

/** Version and installed models; never throws. */
export async function health(http: OllamaHttp): Promise<ModelHealth> {
  const [version, tags] = await Promise.allSettled([
    getParsed(http, VERSION_PATH, VersionSchema),
    getParsed(http, TAGS_PATH, TagsSchema),
  ]);
  if (version.status === 'rejected')
    return { reachable: false, models: [], error: healthError(version.reason, http.baseUrl) };
  if (tags.status === 'rejected')
    return {
      reachable: true,
      version: version.value.version,
      models: [],
      error: healthError(tags.reason, http.baseUrl),
    };
  return {
    reachable: true,
    version: version.value.version,
    models: tags.value.models.map((m) => ({ name: m.name, capabilities: m.capabilities ?? [] })),
  };
}
