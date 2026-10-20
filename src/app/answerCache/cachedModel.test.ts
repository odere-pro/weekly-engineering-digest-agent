import { describe, expect, it } from 'vitest';
import { FakeModelProvider, yesNoAnswers } from '../../../test/fakes';
import { PROFILES, type ModelProfile } from '../../config/profiles';
import type {
  DecideRequest,
  GenerateRequest,
  ModelHealth,
  ModelProvider,
} from '../../models/ModelProvider';
import type { Role } from '../../models/roles';
import type { LogFields, Logger } from '../../shared/telemetry';
import type { SamplingSettings } from './answerKey';
import type { AnswerStore, StoredAnswer } from './answerStore';
import { cacheAnswers } from './cachedModel';

const WEEK = '2026-W43';
const CLEF = 'clef:latest';
const GRANITE = 'granite4.1-guardian:8b';

function healthWith(digests: Readonly<Record<string, string>>): ModelHealth {
  return {
    reachable: true,
    version: '0.40.5',
    models: Object.entries(digests).map(([name, digest]) => ({
      name,
      capabilities: [],
      digest,
    })),
  };
}

const HEALTHY = healthWith({ [CLEF]: 'c1', [GRANITE]: 'g1' });

const CLASSIFY: DecideRequest = {
  role: 'classify',
  state: '<<<DATA item-1>>>\nTitle: Kubernetes 1.36\n<<<END DATA>>>',
  questions: { hype: { type: 'yesno', instructions: 'Is it hype?' } },
};

const GRANITE_CALL: GenerateRequest = {
  role: 'guardRisk',
  system: 'Judge jailbreak.',
  prompt: '<<<DATA item-1>>>\nTitle: Kubernetes 1.36\n<<<END DATA>>>',
  temperature: 0,
};

const WRITER_CALL: GenerateRequest = {
  role: 'write',
  model: 'gemma4:31b-mlx',
  system: 'Write the digest.',
  prompt: 'items',
};

interface Line {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: LogFields;
}

function capture(lines: Line[]): Logger {
  const at =
    (level: Line['level']) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, ...(fields ? { fields } : {}) });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

/** The week files of a data folder, kept in memory; shared by two decorators like by two runs. */
function memoryStore(): AnswerStore & { saved: StoredAnswer[] } {
  const saved: StoredAnswer[] = [];
  const weekOf = new Map<StoredAnswer, string>();
  return {
    saved,
    load: (week) => {
      const ofWeek = saved.filter((answer) => weekOf.get(answer) === week);
      return Promise.resolve({ entries: new Map(ofWeek.map((a) => [a.key, a])), skipped: 0 });
    },
    append: (week, answer) => {
      saved.push(answer);
      weekOf.set(answer, week);
      return Promise.resolve();
    },
  };
}

interface Kit {
  inner: FakeModelProvider;
  model: ModelProvider;
  store: AnswerStore & { saved: StoredAnswer[] };
  lines: Line[];
  setWeek(week: string | undefined): void;
  setHealth(health: ModelHealth): void;
}

function makeKit(
  options: {
    store?: AnswerStore & { saved: StoredAnswer[] };
    profile?: ModelProfile;
    sampling?: (role: Role) => SamplingSettings;
    decideAnswer?: number;
  } = {},
): Kit {
  let week: string | undefined = WEEK;
  let health = HEALTHY;
  const inner = new FakeModelProvider({
    decide: (request) => yesNoAnswers(request, options.decideAnswer ?? 0.1),
    generate: () => '<score>no</score>',
  });
  inner.health = () => Promise.resolve(health);
  const store = options.store ?? memoryStore();
  const lines: Line[] = [];
  const model = cacheAnswers(inner, {
    store,
    profile: options.profile ?? PROFILES.quality,
    week: () => week,
    sampling: options.sampling ?? (() => ({ temperature: 0, seed: 42, think: false })),
    logger: capture(lines),
  });
  return {
    inner,
    model,
    store,
    lines,
    setWeek: (next) => {
      week = next;
    },
    setHealth: (next) => {
      health = next;
    },
  };
}

describe('cacheAnswers: decide', () => {
  it('asks the model once for a call it has answered this week, then reuses the answer', async () => {
    const kit = makeKit();
    await kit.model.health();

    const first = await kit.model.decide(CLASSIFY);
    const second = await kit.model.decide({ ...CLASSIFY });

    expect(kit.inner.decideCalls).toHaveLength(1);
    expect(second).toEqual({
      model: first.model,
      answers: first.answers,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
    });
    expect(kit.lines).toContainEqual({
      level: 'debug',
      message: 'model answer reused',
      fields: { role: 'classify', model: first.model, op: 'decide' },
    });
  });

  it('reuses what an earlier run of the week saved', async () => {
    const store = memoryStore();
    const firstRun = makeKit({ store });
    await firstRun.model.health();
    await firstRun.model.decide(CLASSIFY);

    const rerun = makeKit({ store, decideAnswer: 0.9 });
    await rerun.model.health();
    const answer = await rerun.model.decide(CLASSIFY);

    expect(rerun.inner.decideCalls).toHaveLength(0);
    expect(answer.answers).toEqual({ hype: { type: 'yesno', probability: 0.1 } });
    expect(rerun.lines).toContainEqual({
      level: 'info',
      message: 'Answer cache loaded',
      fields: { answers: 1 },
    });
  });

  it('reads the week file again at each run, so deleting it makes the next run ask again', async () => {
    const kit = makeKit();
    await kit.model.health();
    await kit.model.decide(CLASSIFY);

    kit.store.saved.splice(0);
    await kit.model.health();
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
  });

  it('asks again after the model was pulled anew (another digest)', async () => {
    const kit = makeKit();
    await kit.model.health();
    await kit.model.decide(CLASSIFY);

    kit.setHealth(healthWith({ [CLEF]: 'c2', [GRANITE]: 'g1' }));
    await kit.model.health();
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
  });

  it('keeps each week apart', async () => {
    const kit = makeKit();
    await kit.model.health();
    await kit.model.decide(CLASSIFY);

    kit.setWeek('2026-W44');
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
  });

  it('passes every call through outside a run', async () => {
    const kit = makeKit();
    kit.setWeek(undefined);
    await kit.model.health();

    await kit.model.decide(CLASSIFY);
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
    expect(kit.store.saved).toEqual([]);
  });

  it('passes calls through until health() has named the model digests', async () => {
    const kit = makeKit();

    await kit.model.decide(CLASSIFY);
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
  });

  it('passes calls through when Ollama was not reachable', async () => {
    const kit = makeKit();
    kit.setHealth({ reachable: false, models: [], error: 'down' });
    await kit.model.health();

    await kit.model.decide(CLASSIFY);
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
  });

  it('passes calls through for a model Ollama lists no digest for, and says so once', async () => {
    const kit = makeKit();
    kit.setHealth(healthWith({ [GRANITE]: 'g1' }));
    await kit.model.health();

    await kit.model.decide(CLASSIFY);
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
    const warnings = kit.lines.filter((line) => line.level === 'warn');
    expect(warnings).toEqual([
      {
        level: 'warn',
        message: 'Answer cache is off for a model Ollama lists no digest for',
        fields: { model: CLEF },
      },
    ]);
  });

  it('matches a tag written without :latest to the one Ollama lists', async () => {
    const kit = makeKit({ profile: { ...PROFILES.quality, classify: 'clef' } });
    await kit.model.health();

    await kit.model.decide(CLASSIFY);
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(1);
  });

  it('saves nothing for a call that failed, so the next one asks again', async () => {
    const kit = makeKit();
    await kit.model.health();
    let fail = true;
    kit.inner.decide = (request) => {
      kit.inner.decideCalls.push(request);
      if (fail) {
        fail = false;
        return Promise.reject(new Error('Ollama timed out'));
      }
      return Promise.resolve({
        model: CLEF,
        answers: yesNoAnswers(request, 0.2),
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      });
    };

    await expect(kit.model.decide(CLASSIFY)).rejects.toThrow('Ollama timed out');
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
    expect(kit.store.saved).toHaveLength(1);
  });

  it('still stops on an aborted run when the answer is saved', async () => {
    const kit = makeKit();
    await kit.model.health();
    await kit.model.decide(CLASSIFY);
    const controller = new AbortController();
    controller.abort(new Error('Run aborted during the classify step'));

    await expect(kit.model.decide({ ...CLASSIFY, signal: controller.signal })).rejects.toThrow(
      'Run aborted during the classify step',
    );
  });
});

describe('cacheAnswers: generate', () => {
  it('reuses a temperature-0 answer (Granite)', async () => {
    const kit = makeKit();
    await kit.model.health();

    const first = await kit.model.generate(GRANITE_CALL);
    const second = await kit.model.generate(GRANITE_CALL);

    expect(kit.inner.generateCalls).toHaveLength(1);
    expect(second).toEqual({
      model: first.model,
      text: '<score>no</score>',
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
    });
  });

  it('never reuses a writer draft', async () => {
    const kit = makeKit({ sampling: () => ({ temperature: 0, seed: 42, think: undefined }) });
    await kit.model.health();

    await kit.model.generate(WRITER_CALL);
    await kit.model.generate(WRITER_CALL);

    expect(kit.inner.generateCalls).toHaveLength(2);
    expect(kit.store.saved).toEqual([]);
  });

  it('never reuses a call that samples above temperature 0', async () => {
    const kit = makeKit({ sampling: () => ({ temperature: 0.3, seed: 42, think: false }) });
    await kit.model.health();
    const { temperature: _ignored, ...withoutTemperature } = GRANITE_CALL;

    await kit.model.generate(withoutTemperature);
    await kit.model.generate(withoutTemperature);
    await kit.model.generate({ ...GRANITE_CALL, temperature: 0.1 });

    expect(kit.inner.generateCalls).toHaveLength(3);
  });
});

describe('cacheAnswers: store trouble', () => {
  it('keeps answering, from memory, when the week file cannot be written; warns once', async () => {
    const store = memoryStore();
    store.append = () => Promise.reject(new Error('EACCES: permission denied'));
    const kit = makeKit({ store });
    await kit.model.health();

    await kit.model.decide(CLASSIFY);
    await kit.model.decide({ ...CLASSIFY, state: `${CLASSIFY.state} ` });
    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(2);
    expect(kit.lines.filter((line) => line.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'Answer cache could not be saved; answers are kept for this run only',
        fields: { error: 'EACCES: permission denied' },
      },
    ]);
  });

  it('starts empty when the week file cannot be read, and warns', async () => {
    const store = memoryStore();
    store.load = () => Promise.reject(new Error('EISDIR: illegal operation on a directory'));
    const kit = makeKit({ store });
    await kit.model.health();

    await kit.model.decide(CLASSIFY);

    expect(kit.inner.decideCalls).toHaveLength(1);
    expect(kit.lines).toContainEqual({
      level: 'warn',
      message: 'Answer cache could not be read; this run starts without it',
      fields: { error: 'EISDIR: illegal operation on a directory' },
    });
  });

  it('says how many lines of the week file it skipped', async () => {
    const store = memoryStore();
    store.load = () => Promise.resolve({ entries: new Map(), skipped: 2 });
    const kit = makeKit({ store });
    await kit.model.health();

    await kit.model.decide(CLASSIFY);

    expect(kit.lines).toContainEqual({
      level: 'warn',
      message: 'Answer cache skipped unreadable lines',
      fields: { skipped: 2 },
    });
  });
});

describe('cacheAnswers: health', () => {
  it('passes the health answer through unchanged', async () => {
    const kit = makeKit();
    await expect(kit.model.health()).resolves.toEqual(HEALTHY);
  });
});
