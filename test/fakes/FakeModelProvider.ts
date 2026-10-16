import type {
  DecideRequest,
  DecideResult,
  DecisionAnswer,
  GenerateRequest,
  GenerateResult,
  ModelHealth,
  ModelProvider,
} from '../../src/ports/ModelProvider.js';

type GenerateHandler = (request: GenerateRequest) => string | Promise<string>;
type DecideHandler = (
  request: DecideRequest,
) => Record<string, DecisionAnswer> | Promise<Record<string, DecisionAnswer>>;

export interface FakeModelProviderOptions {
  /** Text to return per call. Throw inside to simulate a failure. */
  generate?: GenerateHandler;
  decide?: DecideHandler;
  health?: ModelHealth;
}

/** Scripted ModelProvider that records every call. */
export class FakeModelProvider implements ModelProvider {
  readonly generateCalls: GenerateRequest[] = [];
  readonly decideCalls: DecideRequest[] = [];
  private readonly options: FakeModelProviderOptions;

  constructor(options: FakeModelProviderOptions = {}) {
    this.options = options;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.generateCalls.push(request);
    if (!this.options.generate)
      throw new Error(`FakeModelProvider: no generate handler (role ${request.role})`);
    const text = await this.options.generate(request);
    return {
      model: request.model ?? `fake-${request.role}`,
      text,
      usage: { inputTokens: request.prompt.length, outputTokens: text.length },
      latencyMs: 1,
    };
  }

  async decide(request: DecideRequest): Promise<DecideResult> {
    this.decideCalls.push(request);
    if (!this.options.decide)
      throw new Error(`FakeModelProvider: no decide handler (role ${request.role})`);
    const answers = await this.options.decide(request);
    return {
      model: `fake-${request.role}`,
      answers,
      usage: { inputTokens: request.state.length, outputTokens: 1 },
      latencyMs: 1,
    };
  }

  health(): Promise<ModelHealth> {
    return Promise.resolve(
      this.options.health ?? { reachable: true, version: '0.40.4', models: [] },
    );
  }
}

/** Answers every yes/no question with `probability`. */
export function yesNoAnswers(
  request: DecideRequest,
  probability: number,
): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, { type: 'yesno', probability } as const]),
  );
}
