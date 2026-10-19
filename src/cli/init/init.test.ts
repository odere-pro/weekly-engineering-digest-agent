import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../config/schema';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../sources/defaultSources';
import {
  CONFIG_PATH,
  EMAIL_RULES,
  ENV_PATH,
  harness,
  SCHEDULE,
  SLACK_RULES,
  writtenConfig,
  writtenEnv,
  writtenEnvText,
} from './__fixtures__/initHarness';
import { initCommand, recommendProfile, resolveOllamaUrl } from './init';
import type { InitPrompts } from './types';

describe('recommendProfile', () => {
  it('recommends light, since quality has no measured baseline yet', () => {
    expect(recommendProfile()).toBe('light');
  });
});

describe('resolveOllamaUrl', () => {
  it.each([
    [true, 'darwin', 'http://host.docker.internal:11434'],
    [true, 'linux', 'http://ollama:11434'],
    [true, undefined, 'http://ollama:11434'],
    [false, 'darwin', 'http://localhost:11434'],
    [false, undefined, 'http://localhost:11434'],
  ])('inDocker=%s hostOs=%s -> %s', (inDocker, hostOs, expected) => {
    expect(resolveOllamaUrl({ inDocker, hostOs })).toBe(expected);
  });
});

describe('initCommand --yes', () => {
  it('writes a config that parses and a secret .env, without asking anything', async () => {
    const h = harness();

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.calls).toEqual([]);
    const config = writtenConfig(h);
    expect(ConfigSchema.safeParse(config).success).toBe(true);
    expect(config['focusAreas']).toEqual([...DEFAULT_FOCUS_AREAS]);
    expect(config['sources']).toEqual([...DEFAULT_SOURCES]);
    expect(config['delivery']).toBeUndefined();
    expect(h.files.get(CONFIG_PATH)?.secret).toBe(false);
    expect(h.files.get(ENV_PATH)?.secret).toBe(true);
    expect(writtenEnv(h)['OLLAMA_URL']).toBe('http://localhost:11434');
  });

  it.each([64, 32, 16, 8])(
    'picks light whatever the RAM (%i GiB): quality is not measured yet',
    async (ramGiB) => {
      const h = harness({ ramGiB });

      await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

      expect(writtenConfig(h)['profile']).toBe('light');
    },
  );

  it('refuses to overwrite an existing config', async () => {
    const h = harness({ existing: [CONFIG_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(CONFIG_PATH);
  });

  it('merges into an existing .env instead of refusing, and keeps what it does not manage', async () => {
    const h = harness({ envText: 'GITHUB_TOKEN=ghp_keep\nLOG_LEVEL=debug\n' });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.err).toEqual([]);
    expect(writtenEnv(h)).toMatchObject({
      GITHUB_TOKEN: 'ghp_keep',
      LOG_LEVEL: 'debug',
      OLLAMA_URL: 'http://localhost:11434',
    });
  });

  it('uses digest.config.json in the working directory by default', async () => {
    const h = harness();

    await initCommand({ yes: true }, h.io);

    expect([...h.files.keys()]).toContain('digest.config.json');
  });

  it('counts the empty files make docker-init created as absent', async () => {
    const h = harness({ empty: [CONFIG_PATH, ENV_PATH] });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.files.get(CONFIG_PATH)?.content).toContain('"focusAreas"');
    expect(h.files.get(ENV_PATH)?.secret).toBe(true);
  });

  it('writes a fresh .env into an empty one, with no merge', async () => {
    const h = harness({ empty: [CONFIG_PATH, ENV_PATH] });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toContain('# Written by "digest init"');
    expect(writtenEnvText(h)).toContain('# GITHUB_TOKEN=');
  });
});

describe('overwrite confirmation', () => {
  it('asks first, naming the existing config, and stops on no', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, false]] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.options.default).toBe(false);
    expect(h.calls[0]?.message).toContain(CONFIG_PATH);
    expect(h.err.join('')).toBe(`Kept ${CONFIG_PATH}. Nothing was written.\n`);
  });

  it('does not ask about .env: it is merged, not replaced', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, true]] });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const questions = h.calls.filter((c) => /Overwrite/.test(c.message));
    expect(questions).toHaveLength(1);
    expect(questions[0]?.message).not.toContain(ENV_PATH);
  });

  it('defaults to keeping the files', async () => {
    const h = harness({ existing: [CONFIG_PATH] });

    expect(await initCommand({ config: CONFIG_PATH }, h.io)).toBe(1);
    expect(h.files.size).toBe(0);
  });

  it('overwrites the config after a yes and updates .env', async () => {
    const h = harness({ existing: [CONFIG_PATH, ENV_PATH], rules: [[/Overwrite/, true]] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.files.has(CONFIG_PATH)).toBe(true);
    expect(h.files.has(ENV_PATH)).toBe(true);
  });

  it('does not ask when only .env exists', async () => {
    const h = harness({ envText: 'LOG_LEVEL=debug\n' });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.calls.some((c) => c.kind === 'confirm')).toBe(false);
  });

  it('does not ask when nothing exists', async () => {
    const h = harness();

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(h.calls.some((c) => c.kind === 'confirm' && /Overwrite/.test(c.message))).toBe(false);
  });
});

describe('OLLAMA_URL by mode', () => {
  it.each([
    ['plain host', { inDocker: false, env: {} }, 'http://localhost:11434'],
    [
      'plain host that sets DIGEST_HOST_OS',
      { inDocker: false, env: { DIGEST_HOST_OS: 'darwin' } },
      'http://localhost:11434',
    ],
    [
      'Docker on a Mac',
      { inDocker: true, env: { DIGEST_HOST_OS: 'darwin' } },
      'http://host.docker.internal:11434',
    ],
    [
      'Docker on Linux',
      { inDocker: true, env: { DIGEST_HOST_OS: 'linux' } },
      'http://ollama:11434',
    ],
    ['Docker, host OS unknown', { inDocker: true, env: {} }, 'http://ollama:11434'],
    [
      'Docker on a Mac, as `uname -s` spells it',
      { inDocker: true, env: { DIGEST_HOST_OS: 'Darwin' } },
      'http://host.docker.internal:11434',
    ],
    [
      'Docker, host OS blank',
      { inDocker: true, env: { DIGEST_HOST_OS: '' } },
      'http://ollama:11434',
    ],
    [
      'a plain host with an unreadable DIGEST_HOST_OS',
      { inDocker: false, env: { DIGEST_HOST_OS: 'plan9' } },
      'http://localhost:11434',
    ],
  ])('%s', async (_name, options, expected) => {
    const h = harness(options);

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)['OLLAMA_URL']).toBe(expected);
  });
});

describe('an unreadable DIGEST_HOST_OS in Docker', () => {
  it('stops before asking anything, and names the variable', async () => {
    const h = harness({ inDocker: true, env: { DIGEST_HOST_OS: 'plan9' } });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain('DIGEST_HOST_OS');
    expect(h.calls).toEqual([]);
    expect(h.files.size).toBe(0);
  });
});

describe('the host reaches the questions', () => {
  const lightDescription = (h: ReturnType<typeof harness>): string =>
    h.calls.find((c) => c.kind === 'select')?.options.choices?.find((c) => c.value === 'light')
      ?.description ?? '';

  it('judges the Mac that runs Ollama, not the Linux container, when Docker names its host', async () => {
    const named = harness({ inDocker: true, platform: 'linux', env: { DIGEST_HOST_OS: 'Darwin' } });
    const unnamed = harness({ inDocker: true, platform: 'linux' });

    await initCommand({ config: CONFIG_PATH }, named.io);
    await initCommand({ config: CONFIG_PATH }, unnamed.io);

    expect(lightDescription(named)).not.toMatch(/fallback/);
    expect(lightDescription(unnamed)).toMatch(/larger fallback models/);
  });

  it('tells a container on UTC that the schedule runs on UTC, at the zone question and after it', async () => {
    const asked = harness({ inDocker: true, timeZone: 'UTC' });
    const defaulted = harness({ inDocker: true, timeZone: 'UTC' });

    await initCommand({ config: CONFIG_PATH }, asked.io);
    await initCommand({ yes: true, config: CONFIG_PATH }, defaulted.io);

    expect(asked.calls.find((c) => /Time zone/.test(c.message))?.message).toContain('TZ');
    expect(defaulted.out.join('')).toContain('schedule.timeZone');
    expect(writtenConfig(defaulted)['schedule']).toEqual({ timeZone: 'UTC' });
  });
});

describe('interactive answers', () => {
  it('writes Markdown only when no extra channel is picked', async () => {
    const h = harness();

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(writtenConfig(h)['delivery']).toBeUndefined();
    expect(Object.keys(writtenEnv(h)).sort()).toEqual(['OLLAMA_URL']);
  });

  it('puts the email fields in the config and the SMTP password in .env only', async () => {
    const h = harness({ rules: EMAIL_RULES });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(writtenConfig(h)['delivery']).toEqual({
      email: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTLS: true,
        user: 'digest@example.com',
        from: 'digest@example.com',
        to: ['ana@example.com', 'bo@example.com'],
      },
    });
    expect(writtenEnv(h)['SMTP_PASSWORD']).toBe('smtp-secret');
    expect(writtenEnv(h)['SLACK_WEBHOOK_URL']).toBeUndefined();
    expect(h.files.get(CONFIG_PATH)?.content).not.toContain('smtp-secret');
  });

  it('puts only the enabled flag in the config and the Slack webhook in .env', async () => {
    const h = harness({ rules: SLACK_RULES });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['delivery']).toEqual({ slack: { enabled: true } });
    expect(writtenEnv(h)['SLACK_WEBHOOK_URL']).toBe(
      'https://hooks.slack.com/services/T000/B000/hook-secret',
    );
    expect(writtenEnv(h)['SMTP_PASSWORD']).toBeUndefined();
    expect(h.files.get(CONFIG_PATH)?.content).not.toContain('hook-secret');
  });

  it('supports email and Slack together', async () => {
    const h = harness({
      rules: [
        [/Deliver the digest/, ['markdown', 'email', 'slack']],
        ...EMAIL_RULES.slice(1),
        ...SLACK_RULES.slice(1),
      ],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const delivery = writtenConfig(h)['delivery'] as Record<string, unknown>;
    expect(Object.keys(delivery).sort()).toEqual(['email', 'slack']);
    expect(Object.keys(writtenEnv(h)).sort()).toEqual([
      'OLLAMA_URL',
      'SLACK_WEBHOOK_URL',
      'SMTP_PASSWORD',
    ]);
  });

  it('turns on implicit TLS by default for port 465 and uses the typed sender', async () => {
    const h = harness({
      rules: [[/SMTP port/, '465'], [/From address/, 'noreply@corp.test'], ...EMAIL_RULES],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const delivery = writtenConfig(h)['delivery'] as { email: Record<string, unknown> };
    expect(delivery.email).toMatchObject({ port: 465, secure: true, from: 'noreply@corp.test' });
  });

  it('keeps secrets with special characters intact in .env', async () => {
    const passwords = ['pa ss#word', `it's "quoted"`, 'back\\nslash', 'x=y $HOME `cmd`'];
    for (const password of passwords) {
      const h = harness({ rules: [[/SMTP password/, password], ...EMAIL_RULES] });

      await initCommand({ config: CONFIG_PATH }, h.io);

      expect(writtenEnv(h)['SMTP_PASSWORD']).toBe(password);
    }
  });

  it('fails cleanly when a secret cannot be stored in .env', async () => {
    const h = harness({ rules: [[/SMTP password/, `a'b"c\`d`], ...EMAIL_RULES] });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain('SMTP_PASSWORD');
    expect(h.err.join('')).not.toContain(`a'b"c\`d`);
  });

  it('merges ticked and typed focus areas without duplicates', async () => {
    const h = harness({
      rules: [
        [/^Focus areas/, ['AI models and tooling']],
        [/Other focus areas/, ' Kubernetes ,ai models and tooling,, Observability '],
      ],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['focusAreas']).toEqual([
      'AI models and tooling',
      'Kubernetes',
      'Observability',
    ]);
  });

  it('writes light by default and the profile that was chosen otherwise', async () => {
    const byDefault = harness();
    const chosen = harness({ rules: [[/Model profile/, 'fast']] });

    await initCommand({ config: CONFIG_PATH }, byDefault.io);
    await initCommand({ config: CONFIG_PATH }, chosen.io);

    expect(writtenConfig(byDefault)['profile']).toBe('light');
    expect(writtenConfig(chosen)['profile']).toBe('fast');
  });

  it('writes the zone the user types, trimmed, and the one it detected on Enter', async () => {
    const typed = harness({ rules: [[/Time zone/, '  America/New_York ']] });
    const detected = harness({ timeZone: 'America/Chicago' });

    await initCommand({ config: CONFIG_PATH }, typed.io);
    await initCommand({ config: CONFIG_PATH }, detected.io);

    expect(writtenConfig(typed)['schedule']).toEqual({ timeZone: 'America/New_York' });
    expect(writtenConfig(detected)['schedule']).toEqual({ timeZone: 'America/Chicago' });
  });

  it('writes the zone this process runs in with --yes, and asks nothing', async () => {
    const h = harness({ timeZone: 'Asia/Tokyo' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenConfig(h)['schedule']).toEqual({ timeZone: 'Asia/Tokyo' });
    expect(h.calls).toEqual([]);
  });

  it('stops without writing when the user cancels with Ctrl+C', async () => {
    const cancel = (): Promise<never> =>
      Promise.reject(
        Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' }),
      );
    const prompts: InitPrompts = {
      confirm: cancel,
      checkbox: cancel,
      input: cancel,
      select: cancel,
      password: cancel,
    };
    const h = harness({ prompts });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toMatch(/cancel/i);
  });

  it('rethrows unexpected prompt failures', async () => {
    const boom = (): Promise<never> => Promise.reject(new Error('tty exploded'));
    const prompts: InitPrompts = {
      confirm: boom,
      checkbox: boom,
      input: boom,
      select: boom,
      password: boom,
    };
    const h = harness({ prompts });

    await expect(initCommand({ config: CONFIG_PATH }, h.io)).rejects.toThrow('tty exploded');
  });

  it('refuses a config that fails validation and writes nothing', async () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `area ${String(i)}`);
    const h = harness({ rules: [[/^Focus areas/, tooMany]] });
    // The scripted user bypasses validate(), as a buggy prompt could.
    h.io.prompts = { ...h.io.prompts, input: () => Promise.resolve('') };

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain('focusAreas');
  });
});

describe('merging into an existing .env', () => {
  const HAND_WRITTEN = '# my settings\nLOG_LEVEL=debug\nGITHUB_TOKEN="ghp_a token # with a hash"\n';

  it('keeps every other line as it was and adds OLLAMA_URL at the end', async () => {
    const h = harness({ envText: HAND_WRITTEN });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(writtenEnvText(h)).toBe(`${HAND_WRITTEN}OLLAMA_URL=http://localhost:11434\n`);
    expect(writtenEnv(h)).toEqual({
      ...parseEnv(HAND_WRITTEN),
      OLLAMA_URL: 'http://localhost:11434',
    });
  });

  it('replaces the secret it was given and keeps the rest', async () => {
    const h = harness({
      envText: 'SMTP_PASSWORD=old\nGITHUB_TOKEN=ghp_keep\n',
      rules: EMAIL_RULES,
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    expect(writtenEnv(h)).toMatchObject({
      SMTP_PASSWORD: 'smtp-secret',
      GITHUB_TOKEN: 'ghp_keep',
    });
  });

  it('writes the merged file through the owner-only writer', async () => {
    const h = harness({ envText: HAND_WRITTEN });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.files.get(ENV_PATH)?.secret).toBe(true);
  });

  it('refuses, and writes nothing, when a line it would replace is part of another value', async () => {
    const trap = 'NOTE="first line\nSMTP_PASSWORD=inside the note"\nLOG_LEVEL=debug\n';
    const h = harness({ envText: trap, rules: EMAIL_RULES });

    const code = await initCommand({ config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toMatch(/Could not merge into .*\.env safely.*by hand/s);
  });

  it('refuses, and writes nothing, when .env cannot be read', async () => {
    const h = harness({
      envText: 'x=1\n',
      envReadError: Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }),
    });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.err.join('')).toContain(`Could not read ${ENV_PATH}: EACCES: denied`);
  });
});

describe('write failures', () => {
  it('reports the file that could not be written and returns 1', async () => {
    const h = harness();
    h.io.writeFile = () => Promise.reject(new Error('EACCES: permission denied'));

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain(CONFIG_PATH);
    expect(h.err.join('')).toContain('EACCES');
  });

  it('reports a .env that could not be written', async () => {
    const h = harness();
    h.io.writeSecretFile = () => Promise.reject(new Error('EROFS: read-only file system'));

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain(ENV_PATH);
    expect(h.err.join('')).toContain('EROFS');
  });

  it('writes the config before the .env, so a config failure leaves .env alone', async () => {
    const h = harness();
    h.io.writeFile = () => Promise.reject(new Error('EACCES: permission denied'));

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.files.has(ENV_PATH)).toBe(false);
  });
});

describe('the output', () => {
  it('lists what was written and never prints a secret', async () => {
    const h = harness({
      rules: [
        [/Deliver the digest/, ['markdown', 'email', 'slack']],
        ...EMAIL_RULES,
        ...SLACK_RULES.slice(1),
      ],
    });

    await initCommand({ config: CONFIG_PATH }, h.io);

    const printed = h.out.join('') + h.err.join('');
    expect(printed).toContain(CONFIG_PATH);
    expect(printed).toContain(ENV_PATH);
    expect(printed).not.toContain('smtp-secret');
    expect(printed).not.toContain('hook-secret');
  });

  it('says it updated .env and kept the rest when it merged, and keeps the plain wording otherwise', async () => {
    const merged = harness({ envText: 'LOG_LEVEL=debug\n' });
    const fresh = harness();

    await initCommand({ yes: true, config: CONFIG_PATH }, merged.io);
    await initCommand({ yes: true, config: CONFIG_PATH }, fresh.io);

    expect(merged.out.join('')).toMatch(/updated .*\.env.*kept its other settings/);
    expect(fresh.out.join('')).toContain(
      `Wrote ${CONFIG_PATH} and ${ENV_PATH} (readable by you only).`,
    );
  });

  it('notes that quality is unmeasured when it was chosen, and not for the other profiles', async () => {
    const quality = harness({ rules: [[/Model profile/, 'quality']] });
    const fast = harness({ rules: [[/Model profile/, 'fast']] });

    await initCommand({ config: CONFIG_PATH }, quality.io);
    await initCommand({ config: CONFIG_PATH }, fast.io);

    expect(quality.out.join('')).toMatch(/note:.*quality is not measured yet.*about 1 h/);
    expect(fast.out.join('')).not.toMatch(/not measured yet/);
  });
});

describe('OS schedule snippet', () => {
  it('prints the rendered schedule outside Docker', async () => {
    const h = harness({ platform: 'linux' });

    await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(h.renderSchedule).toHaveBeenCalledWith('linux', {
      cron: '45 7 * * 1',
      command: '/usr/local/bin/digest run',
      workingDir: '/work',
    });
    const printed = h.out.join('');
    expect(printed).toContain(SCHEDULE.path);
    expect(printed).toContain(SCHEDULE.content);
    expect(printed).toContain(SCHEDULE.installHint);
  });

  it('passes a config outside the working directory on to the scheduled command', async () => {
    const h = harness();

    await initCommand({ yes: true, config: '/srv/my configs/digest.json' }, h.io);

    expect(h.renderSchedule.mock.calls[0]?.[1].command).toBe(
      '/usr/local/bin/digest -c "/srv/my configs/digest.json" run',
    );
  });

  it('skips the snippet inside Docker, where the compose service schedules the run', async () => {
    const h = harness({ inDocker: true });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.renderSchedule).not.toHaveBeenCalled();
    expect(h.out.join('')).not.toContain(SCHEDULE.path);
    expect(h.out.join('')).toContain('docker compose up -d');
  });

  it('prints the reason, and still succeeds, when renderOsSchedule fails', async () => {
    const h = harness();
    h.renderSchedule.mockImplementation(() => {
      throw new Error('renderOsSchedule failed');
    });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    const printed = h.out.join('');
    expect(printed).toContain('No OS schedule snippet is available (renderOsSchedule failed)');
    expect(printed).toContain('digest run');
    expect(printed).toContain('digest serve');
  });

  it('prints the reason, and still succeeds, when the platform has no snippet', async () => {
    const h = harness();
    h.renderSchedule.mockImplementation(() => {
      throw new Error('Unsupported platform: freebsd');
    });

    const code = await initCommand({ yes: true, config: CONFIG_PATH }, h.io);

    expect(code).toBe(0);
    expect(h.out.join('')).toContain('Unsupported platform: freebsd');
  });
});
