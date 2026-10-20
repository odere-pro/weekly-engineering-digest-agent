import { createHash } from 'node:crypto';
import type { DecideRequest, GenerateRequest } from '../../models/ModelProvider';
import type { ThinkSetting } from '../../models/adapters/chat/chatSettings';

/** Bump it when what a key covers changes, so no older answer can match a new key. */
const KEY_VERSION = 1;

/** The server and the exact model weights that answer a call. */
export interface ModelIdentity {
  /** Ollama's own version: an upgrade can change how a model answers. */
  serverVersion: string;
  model: string;
  /** The content hash Ollama lists for the tag: a new pull is a new digest. */
  digest: string;
}

/** What `generate` sends besides the request, as the adapter works it out for the role. */
export interface SamplingSettings {
  temperature: number;
  seed: number | undefined;
  think: ThinkSetting | undefined;
}

/**
 * The payload as JSON, in the order its fields and the request's maps were built. That order is
 * part of what the model reads: questions and choice options reach it in the order they are sent.
 */
function hash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: KEY_VERSION, ...payload }))
    .digest('hex');
}

/** The key of one `decide` call: who answers, and every byte the model reads. */
export function decideKey(identity: ModelIdentity, request: DecideRequest): string {
  return hash({
    op: 'decide',
    ...identity,
    role: request.role,
    state: request.state,
    questions: request.questions,
  });
}

/** The key of one `generate` call: who answers, every byte the model reads, and its sampling. */
export function generateKey(
  identity: ModelIdentity,
  request: GenerateRequest,
  sampling: SamplingSettings,
): string {
  return hash({
    op: 'generate',
    ...identity,
    role: request.role,
    system: request.system,
    prompt: request.prompt,
    jsonSchema: request.jsonSchema ?? null,
    temperature: sampling.temperature,
    seed: sampling.seed ?? null,
    think: sampling.think ?? null,
  });
}
