import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { fixtureText } from '../__fixtures__/ollamaHarness';
import { joinChat } from './chatStream';

/** The recorded chat stream, one parsed line per entry, as the transport hands it over. */
function recordedLines(): unknown[] {
  return fixtureText('chat-stream.ndjson')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

describe('joinChat', () => {
  it('joins the recorded stream into text, counts and the reason it stopped', () => {
    expect(joinChat(recordedLines())).toEqual({
      text: '{"title":"vLLM 0.12 adds speculative decoding"}',
      usage: { inputTokens: 42, outputTokens: 9 },
      doneReason: 'stop',
    });
  });

  it('counts missing token fields as zero', () => {
    const joined = joinChat([{ message: { content: 'hi' }, done: true }]);

    expect(joined.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(joined.doneReason).toBeUndefined();
  });

  it('reports a reply cut at the token limit', () => {
    const joined = joinChat([{ message: { content: 'cut' }, done: true, done_reason: 'length' }]);

    expect(joined).toMatchObject({ text: 'cut', doneReason: 'length' });
  });

  it('treats a line without a message as empty text', () => {
    const joined = joinChat([
      { message: { content: 'a' }, done: false },
      { done: false },
      { message: { content: 'b' }, done: true },
    ]);

    expect(joined.text).toBe('ab');
  });

  it('takes the counts from the last line only', () => {
    const joined = joinChat([
      { message: { content: 'a' }, done: false, eval_count: 1 },
      { message: { content: 'b' }, done: true, prompt_eval_count: 7, eval_count: 3 },
    ]);

    expect(joined.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('rejects a stream that ends before the reply is done', () => {
    const unfinished = (): unknown => joinChat([{ message: { content: 'half' }, done: false }]);

    expect(unfinished).toThrow(DigestError);
    expect(unfinished).toThrow('Ollama ended the /api/chat stream before the reply was done');
  });

  it('rejects an empty stream', () => {
    expect(() => joinChat([])).toThrow(
      'Ollama ended the /api/chat stream before the reply was done',
    );
  });

  it('rejects a line that does not match the chat shape', () => {
    expect(() => joinChat([{ done: 'yes' }])).toThrow(/unexpected \/api\/chat response/);
  });

  it('rejects a payload that is not a list of lines', () => {
    expect(() => joinChat({ done: true })).toThrow(/unexpected \/api\/chat response/);
  });
});
