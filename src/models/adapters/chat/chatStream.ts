import { z } from 'zod';
import { DigestError } from '../../../shared/errors';
import type { Usage } from '../../ModelProvider';
import { parseOllamaResponse } from '../ollamaHttp';

export const CHAT_PATH = '/api/chat';

/** One line of a streamed /api/chat reply; the last line has `done: true` and the counts. */
const ChatChunkSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().min(0).optional(),
  eval_count: z.number().int().min(0).optional(),
});

/** Joins streamed chat lines into the reply text, the counts and why it stopped. */
export function joinChat(raw: unknown): {
  text: string;
  usage: Usage;
  doneReason: string | undefined;
} {
  const chunks = parseOllamaResponse(z.array(ChatChunkSchema), raw, CHAT_PATH);
  const last = chunks.at(-1);
  if (!last?.done)
    throw new DigestError(`Ollama ended the ${CHAT_PATH} stream before the reply was done`);
  return {
    text: chunks.map((chunk) => chunk.message?.content ?? '').join(''),
    usage: { inputTokens: last.prompt_eval_count ?? 0, outputTokens: last.eval_count ?? 0 },
    doneReason: last.done_reason,
  };
}
