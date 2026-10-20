import { describe, expect, it } from 'vitest';
import type { DecideRequest, GenerateRequest } from '../../models/ModelProvider';
import { decideKey, generateKey, type ModelIdentity, type SamplingSettings } from './answerKey';

const IDENTITY: ModelIdentity = {
  serverVersion: '0.40.5',
  model: 'clef:latest',
  digest: '039c167bd0ec3719',
};

const DECIDE: DecideRequest = {
  role: 'classify',
  state: '<<<DATA item-1>>>\nTitle: Kubernetes 1.36\n<<<END DATA>>>',
  questions: {
    hype: { type: 'yesno', instructions: 'Is it hype?' },
    relevance: { type: 'score', instructions: 'How relevant?', levels: ['none', 'some', 'high'] },
  },
};

const GENERATE: GenerateRequest = {
  role: 'guardRisk',
  system: 'Judge jailbreak.',
  prompt: '<<<DATA item-1>>>\nTitle: Kubernetes 1.36\n<<<END DATA>>>',
  temperature: 0,
};

const SAMPLING: SamplingSettings = { temperature: 0, seed: 42, think: false };

describe('decideKey', () => {
  it('is a sha256 hex digest that repeats for the same call', () => {
    const key = decideKey(IDENTITY, DECIDE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(decideKey(IDENTITY, { ...DECIDE })).toBe(key);
  });

  it('ignores the abort signal', () => {
    const withSignal: DecideRequest = { ...DECIDE, signal: new AbortController().signal };
    expect(decideKey(IDENTITY, withSignal)).toBe(decideKey(IDENTITY, DECIDE));
  });

  it('changes with the order of the questions: the model reads them in the order sent', () => {
    const reordered: DecideRequest = {
      ...DECIDE,
      questions: { relevance: DECIDE.questions.relevance!, hype: DECIDE.questions.hype! },
    };
    expect(decideKey(IDENTITY, reordered)).not.toBe(decideKey(IDENTITY, DECIDE));
  });

  it.each<[string, ModelIdentity, DecideRequest]>([
    ['the state', IDENTITY, { ...DECIDE, state: `${DECIDE.state} ` }],
    [
      'a question',
      IDENTITY,
      {
        ...DECIDE,
        questions: { ...DECIDE.questions, hype: { type: 'yesno', instructions: 'Hype?' } },
      },
    ],
    ['the role', IDENTITY, { ...DECIDE, role: 'guardPolicy' }],
    ['the model digest (a new pull)', { ...IDENTITY, digest: 'ffff' }, DECIDE],
    ['the Ollama version', { ...IDENTITY, serverVersion: '0.41.0' }, DECIDE],
    ['the model tag', { ...IDENTITY, model: 'strands-decider:2b-mlx-bf16' }, DECIDE],
  ])('changes with %s', (_name, identity, request) => {
    expect(decideKey(identity, request)).not.toBe(decideKey(IDENTITY, DECIDE));
  });
});

describe('generateKey', () => {
  it('repeats for the same call and ignores the abort signal', () => {
    const key = generateKey(IDENTITY, GENERATE, SAMPLING);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(
      generateKey(IDENTITY, { ...GENERATE, signal: new AbortController().signal }, SAMPLING),
    ).toBe(key);
  });

  it.each<[string, GenerateRequest, SamplingSettings]>([
    ['the system prompt', { ...GENERATE, system: 'Judge harm.' }, SAMPLING],
    ['the prompt', { ...GENERATE, prompt: `${GENERATE.prompt}!` }, SAMPLING],
    ['the JSON schema', { ...GENERATE, jsonSchema: { type: 'object' } }, SAMPLING],
    ['the temperature', GENERATE, { ...SAMPLING, temperature: 0.2 }],
    ['the seed', GENERATE, { ...SAMPLING, seed: 7 }],
    ['no seed', GENERATE, { ...SAMPLING, seed: undefined }],
    ['the think setting', GENERATE, { ...SAMPLING, think: true }],
    ['no think setting', GENERATE, { ...SAMPLING, think: undefined }],
  ])('changes with %s', (_name, request, sampling) => {
    expect(generateKey(IDENTITY, request, sampling)).not.toBe(
      generateKey(IDENTITY, GENERATE, SAMPLING),
    );
  });

  it('never matches a decide call', () => {
    const asDecide: DecideRequest = { role: 'guardRisk', state: GENERATE.prompt, questions: {} };
    expect(generateKey(IDENTITY, GENERATE, SAMPLING)).not.toBe(decideKey(IDENTITY, asDecide));
  });
});
