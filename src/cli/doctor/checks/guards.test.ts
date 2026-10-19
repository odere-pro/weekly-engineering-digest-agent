import { describe, expect, it } from 'vitest';
import { InputGuardsSchema, OutputGuardsSchema } from '../../../config/schema';
import { GuardCheckIdSchema } from '../../../guards/guardVerdict';
import { makeConfig } from '../../../../test/builders';
import { resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { checkGuards, INPUT_CHECKS, OUTPUT_CHECKS } from './guards';

describe('guard check lists', () => {
  it('list every switchable check of the guard config, input and output', () => {
    expect([...INPUT_CHECKS].sort()).toEqual(
      Object.keys(InputGuardsSchema.shape.checks.parse({})).sort(),
    );
    expect([...OUTPUT_CHECKS].sort()).toEqual(
      Object.keys(OutputGuardsSchema.shape.checks.parse({})).sort(),
    );
  });

  it('cover every GuardCheckId', () => {
    // Fails when GuardCheckId gains a guard: list it in guards.ts.
    const covered = [...INPUT_CHECKS, ...OUTPUT_CHECKS];

    expect([...covered].sort()).toEqual([...GuardCheckIdSchema.options].sort());
  });

  it('keep input and output apart', () => {
    expect(
      INPUT_CHECKS.filter((check) => (OUTPUT_CHECKS as readonly string[]).includes(check)),
    ).toEqual([]);
  });
});

describe('checkGuards', () => {
  it('is ok when every guard is on', () => {
    expect(checkGuards(makeConfig().guards)).toEqual({
      severity: 'ok',
      label: 'guards',
      message: 'all guards on',
    });
  });

  it('names a check that is off, input before output', () => {
    const guards = makeConfig({
      guards: {
        input: { checks: { graniteRisk: false } },
        output: { checks: { clefRubric: false } },
      },
    }).guards;

    const result = checkGuards(guards);

    expect(result.severity).toBe('warn');
    expect(result.message).toBe('off: graniteRisk, clefRubric; the digest footer will say so');
  });

  it('names the rule guard first among the input checks', () => {
    const guards = makeConfig({ guards: { input: { enabled: false } } }).guards;

    expect(checkGuards(guards).message).toBe(
      'off: ruleInjection, clefPolicy, graniteRisk; the digest footer will say so',
    );
  });

  it('counts every check of a switched-off section, whatever its own flag says', () => {
    const guards = makeConfig({ guards: { output: { enabled: false } } }).guards;

    expect(checkGuards(guards).message).toBe(
      'off: graniteGroundedness, clefRubric; the digest footer will say so',
    );
  });
});

describe('doctor guards check', () => {
  describe('guards', () => {
    it('lists the rule guard when it is switched off (W11-04)', async () => {
      const { text } = await runDoctor({
        config: { guards: { input: { checks: { ruleInjection: false } } } },
      });

      expect(resultFor(text, '!', 'guards:')).toContain('ruleInjection');
    });

    it('prints ! naming every check of a disabled input section', async () => {
      const { code, text } = await runDoctor({ config: { guards: { input: { enabled: false } } } });

      expect(code).toBe(0);
      const line = resultFor(text, '!', 'guards:');
      expect(line).toContain('clefPolicy');
      expect(line).toContain('graniteRisk');
      expect(line).toMatch(/\n\s+fix: .*digest\.config\.json/);
    });

    it('prints ! naming only the single check that is off', async () => {
      const { text } = await runDoctor({
        config: { guards: { output: { checks: { clefRubric: false } } } },
      });

      const line = resultFor(text, '!', 'guards:');
      expect(line).toContain('clefRubric');
      expect(line).not.toContain('graniteGroundedness');
    });

    it('names input and output checks together', async () => {
      const { text } = await runDoctor({
        config: {
          guards: {
            input: { checks: { graniteRisk: false } },
            output: { enabled: false },
          },
        },
      });

      const line = resultFor(text, '!', 'guards:');
      for (const check of ['graniteRisk', 'graniteGroundedness', 'clefRubric']) {
        expect(line).toContain(check);
      }
      expect(line).not.toContain('clefPolicy');
    });

    it('prints ✓ when every guard is on', async () => {
      const { text } = await runDoctor();

      expect(resultFor(text, '✓', 'guards:')).toMatch(/all .*on/i);
    });
  });
});
