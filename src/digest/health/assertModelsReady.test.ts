import { describe, expect, it } from 'vitest';
import { assertModelsReady } from './assertModelsReady';
import { modelsInUse, requiredModels } from '../../config/profiles';
import type { ConfigInput } from '../../config/schema';
import { DigestError } from '../../shared/errors';
import type { ModelHealth } from '../../models/ModelProvider';
import { FakeModelProvider } from '../../../test/fakes';
import { PROFILE, WRITER_A, WRITER_B, contextFor } from '../__fixtures__/stageKit';

const listing = (...tags: string[]): ModelHealth => ({
  reachable: true,
  models: tags.map((name) => ({ name, capabilities: [] })),
});

function check(health: ModelHealth, config: Partial<ConfigInput> = {}) {
  const h = contextFor({ model: new FakeModelProvider({ health }), config });
  return { ...h, result: assertModelsReady(h.ctx) };
}

describe('assertModelsReady', () => {
  it('passes when Ollama has every model of the profile, and logs the models in use', async () => {
    const h = check(listing(...requiredModels(PROFILE)));

    await expect(h.result).resolves.toBeUndefined();

    expect(h.logs).toEqual([
      {
        level: 'info',
        message: 'Models ready',
        fields: {
          runId: '2026-W42',
          profile: 'quality',
          models: modelsInUse(PROFILE, h.deps.config.guards),
        },
      },
    ]);
  });

  it('treats a tag without a version as :latest, on either side', async () => {
    const others = requiredModels(PROFILE).filter((tag) => tag !== PROFILE.classify);
    const pulledAsClef = contextFor({
      profile: { ...PROFILE, classify: 'clef' },
      model: new FakeModelProvider({ health: listing('clef:latest', ...others) }),
    });
    const listedAsClef = contextFor({
      profile: { ...PROFILE, classify: 'clef:latest' },
      model: new FakeModelProvider({ health: listing('clef', ...others) }),
    });

    await expect(assertModelsReady(pulledAsClef.ctx)).resolves.toBeUndefined();
    await expect(assertModelsReady(listedAsClef.ctx)).resolves.toBeUndefined();
  });

  it('fails when Ollama is unreachable, with the reason it gave', async () => {
    const h = check({
      reachable: false,
      models: [],
      error: 'connect ECONNREFUSED 127.0.0.1:11434',
    });

    await expect(h.result).rejects.toThrow(
      'Ollama is not reachable: connect ECONNREFUSED 127.0.0.1:11434. Start Ollama and run again.',
    );
  });

  it('fails without a reason when Ollama gave none', async () => {
    const h = check({ reachable: false, models: [] });

    await expect(h.result).rejects.toThrow('Ollama is not reachable. Start Ollama and run again.');
  });

  it('fails when the health check itself throws, with the error message', async () => {
    const model = new FakeModelProvider();
    model.health = () => Promise.reject(new Error('socket hang up'));
    const h = contextFor({ model });

    await expect(assertModelsReady(h.ctx)).rejects.toThrow(
      'Ollama is not reachable: socket hang up',
    );
  });

  it('names every missing model and the profile, and that it is a DigestError', async () => {
    const h = check(listing(PROFILE.classify, WRITER_A));

    const error = await h.result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DigestError);
    expect((error as Error).message).toBe(
      `Ollama is missing models for profile "quality": ${[
        PROFILE.guardPolicy,
        PROFILE.guardRisk,
        WRITER_B,
        PROFILE.judge,
      ].join(', ')}. Pull them with "ollama pull <model>".`,
    );
    expect(h.logs).toEqual([]);
  });

  describe('follows the guards in use (F30)', () => {
    const guardRiskOff: Partial<ConfigInput> = {
      guards: {
        input: { checks: { graniteRisk: false } },
        output: { checks: { graniteGroundedness: false } },
      },
    };
    const withoutRisk = requiredModels(PROFILE).filter((tag) => tag !== PROFILE.guardRisk);

    it('does not require the model of a guard role whose checks are all off', async () => {
      await expect(check(listing(...withoutRisk), guardRiskOff).result).resolves.toBeUndefined();
    });

    it('still requires the model of a role that an enabled check uses', async () => {
      const h = check(listing(...withoutRisk));

      await expect(h.result).rejects.toThrow(PROFILE.guardRisk);
    });

    it('always requires the classifier, the writers and the judge', async () => {
      const h = check(listing(PROFILE.classify, WRITER_A, PROFILE.judge ?? ''), {
        guards: { input: { enabled: false }, output: { enabled: false } },
      });

      const error = await h.result.catch((caught: unknown) => caught);

      expect((error as Error).message).toContain(WRITER_B);
      expect((error as Error).message).not.toContain(PROFILE.guardPolicy);
      expect((error as Error).message).not.toContain(PROFILE.guardRisk);
    });

    it('logs the models in use, without the unused one', async () => {
      const h = check(listing(...withoutRisk), guardRiskOff);
      await h.result;

      const [ready] = h.logs;
      expect(ready?.fields.models).toEqual(modelsInUse(PROFILE, h.deps.config.guards));
      expect(ready?.fields.models).not.toContain(PROFILE.guardRisk);
    });
  });
});
