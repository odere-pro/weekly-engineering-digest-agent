import type { Role } from '../domain/schemas';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * A typed question for a decision model. The adapter maps these to the vendor's format
 * (Ollama /v1/systemone: yesno -> "noul", choice -> "choice", score -> "score").
 */
export type DecisionQuestion =
  | {
      type: 'yesno';
      instructions: string;
      /** What "yes" and "no" mean, when not obvious from the instructions. */
      criteria?: { yes: string; no: string };
    }
  | {
      type: 'choice';
      instructions: string;
      /** Option name -> description (or null). 2-26 options. */
      options: Readonly<Record<string, string | null>>;
    }
  | {
      type: 'score';
      instructions: string;
      /** Ordered levels, lowest first. 2-10 levels. */
      levels: readonly string[];
    };

export type DecisionAnswer =
  | { type: 'yesno'; /** Probability that the statement is true. */ probability: number }
  | {
      type: 'choice';
      choice: string;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    }
  | {
      type: 'score';
      /** Expected level index, 0 = lowest level. */
      level: number;
      /** Expected level normalized to 0..1. */
      score: number;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    };

export interface DecideRequest {
  role: Role;
  /** The text the questions are about. Untrusted content must be wrapped with wrapUntrusted(). */
  state: string;
  /** Question id -> question. 1-64 questions. */
  questions: Readonly<Record<string, DecisionQuestion>>;
  signal?: AbortSignal;
}

export interface DecideResult {
  model: string;
  answers: Readonly<Record<string, DecisionAnswer>>;
  usage: Usage;
  latencyMs: number;
}

export interface GenerateRequest {
  role: Role;
  /** Explicit model tag; used by the writer panel. Otherwise resolved from the role. */
  model?: string;
  system: string;
  prompt: string;
  /** JSON Schema the output must match (Ollama structured outputs). */
  jsonSchema?: Readonly<Record<string, unknown>>;
  temperature?: number;
  /** Sampling seed, so two runs of one week can produce the same text (W7-03). */
  seed?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  model: string;
  text: string;
  usage: Usage;
  latencyMs: number;
}

export interface ModelHealth {
  reachable: boolean;
  version?: string;
  models: readonly { name: string; capabilities: readonly string[] }[];
  error?: string;
}

/** Every model call goes through this port. Adapters own timeouts and retries per role. */
export interface ModelProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  decide(request: DecideRequest): Promise<DecideResult>;
  health(): Promise<ModelHealth>;
}
