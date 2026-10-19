import { describe, expect, it } from 'vitest';
import { modelsInUse, PROFILES } from '../../../config/profiles';
import { effectiveThink } from '../../../models/adapters/ollama';
import { makeConfig } from '../../../../test/builders';
import { installedFor, loadedFor, resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { checkModels, checkThink, describeThink } from './models';

describe('describeThink', () => {
  it.each([
    [undefined, 'default'],
    [true, 'on'],
    [false, 'off'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ] as const)('writes %s as "%s"', (setting, expected) => {
    expect(describeThink(setting)).toBe(expected);
  });
});

describe('checkThink', () => {
  it('lists the roles that can send think, in a fixed order', () => {
    const result = checkThink(loadedFor());

    expect(result).toEqual({
      severity: 'ok',
      label: 'think',
      message: 'classify=default, guardRisk=off, write=default',
    });
  });

  it('warns about every decision-only role that has a setting, in a fixed order', () => {
    const loaded = loadedFor({
      config: { models: { think: { judge: 'low', guardPolicy: false } } },
    });

    const result = checkThink(loaded);

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('ignored for guardPolicy, judge, which take no think setting');
    expect(result.fix).toBe('remove those roles from "models" > "think" in digest.config.json');
  });
});

describe('checkModels', () => {
  const loaded = loadedFor();
  const { profile, config } = loaded;

  it('returns nothing when Ollama is unreachable', () => {
    expect(checkModels({ reachable: false, models: [] }, profile, config.guards)).toEqual([]);
  });

  it('returns nothing when Ollama could not list its models', () => {
    expect(
      checkModels({ reachable: true, models: [], error: 'HTTP 500' }, profile, config.guards),
    ).toEqual([]);
  });

  it('reports one line per model in use, installed or not', () => {
    const models = installedFor(profile, ['gemma4:31b-mlx']);

    const results = checkModels({ reachable: true, models }, profile, config.guards);

    expect(results.map((r) => [r.label, r.severity])).toEqual(
      modelsInUse(profile, config.guards).map((tag) => [
        `model ${tag}`,
        tag === 'gemma4:31b-mlx' ? 'error' : 'ok',
      ]),
    );
  });

  it('gives the pull command as the fix for a missing model', () => {
    const results = checkModels({ reachable: true, models: [] }, profile, config.guards);

    expect(results[0]).toMatchObject({
      severity: 'error',
      message: 'not installed',
      fix: `ollama pull ${modelsInUse(profile, config.guards)[0]}`,
    });
  });

  it('says "(decision model)" for a tag that classify, guardPolicy or judge use', () => {
    const models = installedFor(profile);

    const results = checkModels({ reachable: true, models }, profile, config.guards);

    expect(results.find((r) => r.label === 'model clef:latest')?.message).toBe(
      'installed (decision model)',
    );
    expect(results.find((r) => r.label === 'model gemma4:31b-mlx')?.message).toBe('installed');
  });
});

describe('doctor think and model checks', () => {
  describe('think', () => {
    it('prints the effective think setting for the roles that can send it', async () => {
      const { text } = await runDoctor();

      expect(resultFor(text, '✓', 'think:')).toBe(
        '✓ think: classify=default, guardRisk=off, write=default',
      );
    });

    it('shows a configured setting over the default', async () => {
      const { text } = await runDoctor({
        config: { models: { think: { write: 'high', guardRisk: true, classify: false } } },
      });

      expect(resultFor(text, '✓', 'think:')).toBe(
        '✓ think: classify=off, guardRisk=on, write=high',
      );
    });

    it('shows what the Ollama adapter sends for each role (effectiveThink), so the two cannot drift', async () => {
      const think = { classify: 'low', guardRisk: true, write: false } as const;
      const { text } = await runDoctor({ config: { models: { think } } });

      const expected = (['classify', 'guardRisk', 'write'] as const).map((role) => {
        const value = effectiveThink(think, role);
        return `${role}=${typeof value === 'boolean' ? (value ? 'on' : 'off') : (value ?? 'default')}`;
      });
      expect(resultFor(text, '✓', 'think:')).toBe(`✓ think: ${expected.join(', ')}`);
    });

    it('warns when a decision-only role is configured, since decide never sends think', async () => {
      const { code, text } = await runDoctor({
        config: { models: { think: { judge: 'low', guardPolicy: false } } },
      });

      expect(resultFor(text, '!', 'think:')).toMatch(
        /ignored for guardPolicy, judge.*\n\s+fix: remove those roles/,
      );
      expect(code).toBe(0);
    });
  });

  describe('models', () => {
    it('prints ✗ with the pull command for each missing model', async () => {
      const { code, text } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile, ['gemma4:31b-mlx', 'granite4.1-guardian:8b']),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model gemma4:31b-mlx:')).toMatch(
        /not installed.*\n\s+fix: ollama pull gemma4:31b-mlx$/,
      );
      expect(resultFor(text, '✗', 'model granite4.1-guardian:8b:')).toMatch(
        /\n\s+fix: ollama pull granite4\.1-guardian:8b$/,
      );
      expect(resultFor(text, '✓', 'model clef:latest:')).toBeDefined();
    });

    it('prints ✗ when a decision model is installed without the decision capability', async () => {
      const { code, text } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile).map((model) =>
            model.name === 'clef:latest' ? { ...model, capabilities: ['completion'] } : model,
          ),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model clef:latest:')).toMatch(
        /decision.*\n\s+fix: ollama pull clef:latest$/,
      );
    });

    it('does not require the decision capability from writer and Granite models', async () => {
      const { code } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile).map((model) =>
            model.name === 'clef:latest' ? model : { ...model, capabilities: [] },
          ),
        }),
      });

      expect(code).toBe(0);
    });

    describe('only the models a run would load (modelsInUse)', () => {
      const graniteOff = {
        guards: {
          input: { checks: { graniteRisk: false } },
          output: { checks: { graniteGroundedness: false } },
        },
      } as const;

      it('does not require the Granite model when both of its guards are off', async () => {
        const { code, text } = await runDoctor({
          config: graniteOff,
          health: (profile) => ({ models: installedFor(profile, ['granite4.1-guardian:8b']) }),
        });

        expect(code).toBe(0);
        expect(text).not.toContain('model granite4.1-guardian:8b');
        expect(resultFor(text, '✓', 'model clef:latest:')).toBeDefined();
        expect(resultFor(text, '!', 'guards:')).toContain('graniteRisk');
      });

      it('still requires it when only one of its two guards is off', async () => {
        const { code, text } = await runDoctor({
          config: { guards: { input: { checks: { graniteRisk: false } } } },
          health: (profile) => ({ models: installedFor(profile, ['granite4.1-guardian:8b']) }),
        });

        expect(code).toBe(1);
        expect(resultFor(text, '✗', 'model granite4.1-guardian:8b:')).toBeDefined();
      });

      it('keeps a tag that another role still uses when the guard of one role is off', async () => {
        const { text } = await runDoctor({
          config: {
            profile: 'fast',
            guards: { input: { enabled: false }, output: { checks: { clefRubric: false } } },
          },
          health: (profile) => ({ version: '0.40.0', models: installedFor(profile) }),
        });

        // guardPolicy has no check left, but classify uses the same strands-decider tag.
        expect(resultFor(text, '✓', 'model strands-decider:2b-mlx-bf16:')).toBeDefined();
      });

      it('lists exactly modelsInUse(profile, guards), in that order', async () => {
        const config = {
          guards: { input: { enabled: false }, output: { enabled: false } },
        } as const;
        const { text } = await runDoctor({ config, health: (p) => ({ models: installedFor(p) }) });

        const listed = [...text.matchAll(/^[✓!✗] model (.+?): /gm)].map((match) => match[1]);
        expect(listed).toEqual(modelsInUse(PROFILES.quality, makeConfig(config).guards));
        expect(listed).not.toContain('granite4.1-guardian:8b');
      });
    });

    it('checks the strands-decider decision models of the fast profile', async () => {
      const { code, text } = await runDoctor({
        config: { profile: 'fast' },
        health: (profile) => ({
          version: '0.40.0',
          models: installedFor(profile).map((model) =>
            model.name === 'strands-decider:2b-mlx-bf16' ? { ...model, capabilities: [] } : model,
          ),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model strands-decider:2b-mlx-bf16:')).toBeDefined();
    });

    it('does not mistake a registry port for a version tag', async () => {
      const tag = 'localhost:5000/team/writer';
      const { code, text } = await runDoctor({
        config: { models: { writers: [tag] } },
        health: (profile) => ({
          models: [...installedFor(profile), { name: `${tag}:latest`, capabilities: [] }],
        }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', `model ${tag}:`)).toBeDefined();
    });

    it('treats a tag without a version as :latest', async () => {
      const { code, text } = await runDoctor({
        config: { models: { writers: ['my-writer'] } },
        health: (profile) => ({
          models: [...installedFor(profile), { name: 'my-writer:latest', capabilities: [] }],
        }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'model my-writer:')).toBeDefined();
    });

    it('checks the configured writer override instead of the profile writers', async () => {
      const { text } = await runDoctor({
        config: { models: { writers: ['gemma4:31b'] } },
        health: (profile) => ({ models: installedFor(profile) }),
      });

      expect(resultFor(text, '✓', 'model gemma4:31b:')).toBeDefined();
      expect(text).not.toContain('gemma4:31b-mlx');
    });
  });
});
