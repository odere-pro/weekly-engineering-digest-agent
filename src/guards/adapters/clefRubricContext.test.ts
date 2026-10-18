// The rubric guard sends the whole rendered digest to a real Ollama provider. A draft that passes
// the format check (under 500 words) must reach the model whole, whichever decision model runs;
// only a draft that outgrows the model's context is cut, and then the cut is logged.
import { describe, expect, it, vi } from 'vitest';
import { createClefRubricGuard } from './clefPolicy';
import { createOllamaProvider } from '../../models/adapters/ollama';
import { PROFILES } from '../../config/profiles';
import { rubricQuestions, rubricState } from '../guardQuestions';
import type { Draft } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { makeDigestItem, makeDraft, makeItem } from '../../../test/builders';

const THRESHOLD = 0.35;
const WORDS_PER_FIELD = 45;

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
}

/** Five items, 90 words each: about 450 words, the most the format check lets through. */
function fullSizeDraft(): Draft {
  const items = Array.from({ length: 5 }, () => makeItem());
  const draft = makeDraft(items);
  return {
    ...draft,
    digest: {
      ...draft.digest,
      items: items.map((item) =>
        makeDigestItem(item, {
          summary: words(WORDS_PER_FIELD),
          whyItMatters: words(WORDS_PER_FIELD),
        }),
      ),
    },
  };
}

function oversizedDraft(chars: number): Draft {
  const item = makeItem();
  const draft = makeDraft([item, makeItem(), makeItem()]);
  const [head, ...rest] = draft.digest.items;
  return {
    ...draft,
    digest: { ...draft.digest, items: [{ ...head!, summary: 'x'.repeat(chars) }, ...rest] },
  };
}

function noopLogger(warnings: string[]): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message) => {
      warnings.push(message);
    },
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

/** An Ollama that answers every rubric question with a low probability and keeps the requests. */
function rubricGuardOn(profile: typeof PROFILES.quality) {
  const requests: { state: string; questions: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  const fakeFetch = (_url: unknown, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(init?.body as string) as (typeof requests)[number]);
    const answers = Object.fromEntries(
      rubricQuestions().map(({ id }) => [id, { type: 'noul', noul: 0.01 }]),
    );
    return Promise.resolve(new Response(JSON.stringify({ answers }), { status: 200 }));
  };
  const model = createOllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    profile,
    fetch: fakeFetch,
    logger: noopLogger(warnings),
  });
  return { guard: createClefRubricGuard({ model, flagThreshold: THRESHOLD }), requests, warnings };
}

describe.each([
  ['clef (quality profile)', PROFILES.quality],
  ['strands-decider (light profile)', PROFILES.light],
])('clefRubric on %s', (_name, profile) => {
  it('sends a draft that passes the format check to the model whole', async () => {
    const { guard, requests, warnings } = rubricGuardOn(profile);
    const draft = fullSizeDraft();

    const verdict = await guard.checkDraft(draft, []);

    expect(verdict.flagged).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe(rubricState(draft));
    expect(warnings).toEqual([]);
  });
});

describe('clefRubric on an oversized draft', () => {
  it('cuts the middle only past the model limit, after the questions, and logs it', async () => {
    const { guard, requests, warnings } = rubricGuardOn(PROFILES.light);
    const draft = oversizedDraft(30_000);
    const state = rubricState(draft);

    await guard.checkDraft(draft, []);

    const sent = requests[0]!;
    const questionChars = JSON.stringify(sent.questions).length;
    expect(state.length).toBeGreaterThan(10_000);
    expect(sent.state.length + questionChars).toBeLessThanOrEqual(10_000);
    expect(sent.state).toContain('[... trimmed ...]');
    expect(sent.state.startsWith(state.slice(0, 200))).toBe(true);
    expect(sent.state.endsWith(state.slice(-200))).toBe(true);
    expect(warnings).toEqual(['decide state trimmed']);
  });

  it('still fits a draft on clef that strands-decider would have to cut', async () => {
    const { guard, requests, warnings } = rubricGuardOn(PROFILES.quality);
    const draft = oversizedDraft(30_000);

    await guard.checkDraft(draft, []);

    expect(requests[0]!.state).toBe(rubricState(draft));
    expect(warnings).toEqual([]);
  });
});
