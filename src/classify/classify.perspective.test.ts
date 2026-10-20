import { describe, expect, it } from 'vitest';
import { classifyStep } from './classify';
import { QUESTION_IDS } from './classifyPrompt';
import {
  answerBatch,
  answersFor,
  idsInPrompt,
  makeDeps,
  makeItems,
  rescoreReply,
} from './__fixtures__/classifyKit';
import { FakeModelProvider } from '../../test/fakes';

const TOPIC = 'Rust adoption';
const LINE = `This week's perspective: "${TOPIC}".`;
const RELEVANCE_TAIL = `and this week is specifically interested in: "${TOPIC}"?`;

describe('classifyStep with a perspective', () => {
  it('decide path: asks the relevance question with the topic, the others unchanged', async () => {
    const model = new FakeModelProvider({ decide: () => answersFor() });
    const plain = new FakeModelProvider({ decide: () => answersFor() });

    await classifyStep(makeItems(1), makeDeps(model, { perspective: TOPIC }));
    await classifyStep(makeItems(1), makeDeps(plain));

    const asked = model.decideCalls[0]?.questions ?? {};
    const base = plain.decideCalls[0]?.questions ?? {};
    const relevance = asked[QUESTION_IDS.relevance];
    expect(relevance?.type === 'score' && relevance.instructions).toContain(RELEVANCE_TAIL);
    expect(JSON.stringify(base)).not.toContain('specifically interested');
    for (const id of [QUESTION_IDS.area, QUESTION_IDS.hype, QUESTION_IDS.minorRelease])
      expect(asked[id]).toEqual(base[id]);
  });

  it('generate path: the batch system prompt carries the perspective line', async () => {
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });
    const plain = new FakeModelProvider({ generate: (request) => answerBatch(request) });

    await classifyStep(makeItems(2), makeDeps(model, { mode: 'generate', perspective: TOPIC }));
    await classifyStep(makeItems(2), makeDeps(plain, { mode: 'generate' }));

    expect(model.generateCalls[0]?.system).toContain(LINE);
    expect(plain.generateCalls[0]?.system).not.toContain('perspective');
  });

  it('rescore path: the writer system prompt carries the perspective line', async () => {
    const rescore = (request: { prompt: string }) =>
      rescoreReply(
        idsInPrompt(request.prompt).map((itemId) => ({
          itemId,
          relevance: 3,
          area: 'Platform engineering',
          confidence: 'high',
        })),
      );
    const model = new FakeModelProvider({ decide: () => answersFor(), generate: rescore });
    const plain = new FakeModelProvider({ decide: () => answersFor(), generate: rescore });
    const options = { rescoreWithWriter: true, minRelevance: 1 };

    await classifyStep(makeItems(2), makeDeps(model, { ...options, perspective: TOPIC }));
    await classifyStep(makeItems(2), makeDeps(plain, options));

    const call = model.generateCalls.find((request) => request.role === 'write');
    expect(call?.system).toContain(LINE);
    expect(plain.generateCalls[0]?.system).not.toContain('perspective');
  });

  it('treats a blank or quote-only topic as no perspective and strips quotes', async () => {
    const blank = new FakeModelProvider({ decide: () => answersFor() });
    const quoted = new FakeModelProvider({ decide: () => answersFor() });

    await classifyStep(makeItems(1), makeDeps(blank, { perspective: ' "" ' }));
    await classifyStep(makeItems(1), makeDeps(quoted, { perspective: 'a "b"\nc' }));

    expect(JSON.stringify(blank.decideCalls[0]?.questions)).not.toContain('specifically');
    expect(JSON.stringify(quoted.decideCalls[0]?.questions)).toContain(
      'interested in: \\"a b c\\"',
    );
  });
});
