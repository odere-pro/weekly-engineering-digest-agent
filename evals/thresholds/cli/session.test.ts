import { describe, expect, it } from 'vitest';
import { PROFILES } from '../../../src/config/profiles';
import { ThresholdsSchema } from '../../../src/config/schema';
import { fakeApp as app, installed, lightModels } from '../__fixtures__/appKit';
import { captureSession } from './session';

describe('captureSession', () => {
  it('names the profile models and the Ollama version, and starts from the config thresholds', async () => {
    const { handle } = app({
      reachable: true,
      version: '0.40.4',
      models: installed(...lightModels),
    });
    const session = await captureSession(handle);
    expect(session).toMatchObject({
      profile: 'light',
      models: { classify: 'strands-decider:2b-mlx-bf16', guardRisk: 'granite4.1-guardian:8b' },
      ollamaVersion: '0.40.4',
      baseline: ThresholdsSchema.parse({}),
    });
    expect(session.deps.clefRubric.id).toBe('clefRubric');
  });

  it('closes the app through the session', async () => {
    const { handle, closed } = app({ reachable: true, models: installed(...lightModels) });
    const session = await captureSession(handle);
    await session.close();
    expect(closed()).toBe(1);
  });

  it('has no Ollama version when Ollama does not report one', async () => {
    const { handle } = app({ reachable: true, models: installed(...lightModels) });
    expect((await captureSession(handle)).ollamaVersion).toBeNull();
  });

  it('refuses to start and closes the app when a profile model is not pulled', async () => {
    const { handle, closed } = app({ reachable: true, models: installed(PROFILES.light.classify) });
    await expect(captureSession(handle)).rejects.toThrow(/lacks granite4\.1-guardian:8b/);
    expect(closed()).toBe(1);
  });

  it('refuses to start when Ollama does not answer', async () => {
    const { handle } = app({ reachable: false, models: [], error: 'ECONNREFUSED' });
    await expect(captureSession(handle)).rejects.toThrow('Ollama is not reachable: ECONNREFUSED');
  });

  it('says "no answer" when Ollama is down without a reason', async () => {
    const { handle } = app({ reachable: false, models: [] });
    await expect(captureSession(handle)).rejects.toThrow('Ollama is not reachable: no answer');
  });

  it('refuses to start when the app has no clefPolicy guard', async () => {
    const health = { reachable: true, models: installed(...lightModels) };
    const { handle, closed } = app(health, ['graniteRisk']);
    await expect(captureSession(handle)).rejects.toThrow('The app has no clefPolicy guard');
    expect(closed()).toBe(1);
  });

  it('refuses to start when the app has no clefRubric output guard', async () => {
    const health = { reachable: true, models: installed(...lightModels) };
    const { handle } = app(health, undefined, ['graniteGroundedness']);
    await expect(captureSession(handle)).rejects.toThrow('The app has no clefRubric guard');
  });
});
