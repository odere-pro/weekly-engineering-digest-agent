import type { GenerateRequest } from '../../ModelProvider';
import type { ThinkSetting } from './chatSettings';

/** The JSON body of a streamed /api/chat call. A request's own temperature and seed win. */
export function chatBody(
  model: string,
  request: GenerateRequest,
  think: ThinkSetting | undefined,
  sampling: { temperature: number; seed: number | undefined },
): Record<string, unknown> {
  const seed = request.seed ?? sampling.seed;
  const options = {
    temperature: request.temperature ?? sampling.temperature,
    ...(seed === undefined ? {} : { seed }),
  };
  return {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
    // Streamed so headers arrive early: Node's fetch drops a response whose headers take
    // more than 300 s, which a non-streamed writer reply can exceed.
    stream: true,
    ...(think === undefined ? {} : { think }),
    ...(request.jsonSchema === undefined ? {} : { format: request.jsonSchema }),
    options,
  };
}
