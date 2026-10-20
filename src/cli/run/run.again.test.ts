import { describe, expect, it } from 'vitest';
import { makeItem, makeRunRecord } from '../../../test/builders';
import { CapturingDelivery } from '../../../test/fakes';
import type { Rule } from '../init/__fixtures__/initHarness';
import {
  CONFIG_PATH,
  harness,
  sentResult,
  text,
  variantResult,
  type Harness,
  type HarnessOptions,
} from './__fixtures__/runHarness';
import { runCommand, type RunCommandOptions } from './run';

const WEEK = '2026-W43';
const SENT_URL = 'https://example.com/a';
const items = [makeItem({ url: SENT_URL }), makeItem({ url: 'https://example.com/b' })];
const NAMES: Record<string, string> = {
  enrich: 'enriched',
  'add-sources': 'enriched',
  complete: 'complete',
  perspective: 'perspective-security',
};

interface Setup extends HarnessOptions {
  status?: 'sent' | 'dry-run';
  saved?: boolean;
  slug?: string;
}

function week(setup: Setup = {}): Harness {
  const h = harness(variantResult(setup.slug ?? 'enriched'), {
    interactive: true,
    ...setup,
    deliveries: setup.deliveries ?? [new CapturingDelivery('markdown')],
  });
  const status = setup.status ?? 'sent';
  h.store.records.set(
    WEEK,
    makeRunRecord({ runId: WEEK, status, dryRun: status === 'dry-run', sentUrls: [SENT_URL] }),
  );
  if (setup.saved !== false) h.store.artifacts.set(`${WEEK}/items.json`, JSON.stringify(items));
  return h;
}

const pick = (kind: string): Rule => [/What now/, kind];

describe('runCommand: the week already has a digest', () => {
  it('Skip (Enter) keeps today: a sent week is skipped by runDigest', async () => {
    const h = week();

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(h.calls.map((c) => c.message)).toEqual([
      'Week 2026-W43 already has a sent digest. What now?',
    ]);
    expect(h.runDigest).toHaveBeenCalledWith(h.appDeps, {
      sinceDays: undefined,
      dryRun: undefined,
      force: undefined,
    });
  });

  it('Skip on a dry-run week is the full re-run it always was', async () => {
    const h = week({ status: 'dry-run' });

    await runCommand({ dryRun: true }, h.deps);

    expect(h.calls[0]?.message).toBe('Week 2026-W43 already has a dry-run digest. What now?');
    expect(h.runDigest).toHaveBeenCalledWith(h.appDeps, {
      sinceDays: undefined,
      dryRun: true,
      force: undefined,
    });
  });

  it.each([
    ['enrich', undefined],
    ['complete', []],
  ])('%s: builds the variant from the saved items without sending', async (kind, ids) => {
    const h = week({ rules: [pick(kind)], slug: NAMES[kind] });

    const code = await runCommand({ since: '14d' }, h.deps);

    expect(code).toBe(0);
    const reuse = ids === undefined ? { items } : { items, fetchSourceIds: ids };
    expect(h.runDigest).toHaveBeenCalledWith(h.appDeps, {
      sinceDays: 14,
      dryRun: true,
      force: true,
      reuse,
      variant: { kind, keepUrls: [SENT_URL] },
    });
  });

  it('perspective: asks for the topic and passes it on', async () => {
    const h = week({ rules: [pick('perspective'), [/perspective/, 'AI agents']] });

    await runCommand({}, h.deps);

    const options = h.runDigest.mock.calls[0]?.[1];
    expect(options?.variant).toMatchObject({ kind: 'perspective', topic: 'AI agents' });
    expect(options?.reuse?.fetchSourceIds).toEqual([]);
  });

  it('add sources: builds the app with the new sources and fetches only those', async () => {
    const h = week({
      rules: [pick('add-sources'), [/Source URLs/, 'https://new.example.com/feed']],
    });

    await runCommand({}, h.deps);

    const built = h.buildApp.mock.calls[0]![0];
    expect(built.config.sources.map((s) => s.id)).toEqual(['example-feed', 'new-example-com-feed']);
    expect(h.runDigest.mock.calls[0]?.[1].reuse?.fetchSourceIds).toEqual(['new-example-com-feed']);
    expect(h.calls.map((c) => c.message)).toContain('Save to digest.config.json for future weeks?');
    expect(h.written.size).toBe(0);
  });

  it('add sources: saves them to the config file after a yes', async () => {
    const h = week({
      configText: JSON.stringify({ focusAreas: ['AI'], topN: 4, sources: [] }),
      rules: [
        pick('add-sources'),
        [/Source URLs/, 'https://new.example.com/feed'],
        [/Save to/, true],
      ],
    });

    await runCommand({}, h.deps);

    const saved = JSON.parse(h.written.get(CONFIG_PATH) ?? '{}') as {
      topN: number;
      sources: unknown[];
    };
    expect(saved.topN).toBe(4);
    expect(saved.sources).toHaveLength(1);
  });

  it('add sources: a save that fails is a warning, the run goes on', async () => {
    const h = week({
      configText: undefined,
      rules: [
        pick('add-sources'),
        [/Source URLs/, 'https://new.example.com/feed'],
        [/Save to/, true],
      ],
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(text(h.err)).toMatch(/Warning: could not save the sources/);
    expect(h.runDigest).toHaveBeenCalledOnce();
  });

  it('stops with a message when the week has no saved items', async () => {
    const h = week({ rules: [pick('enrich')], saved: false });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toMatch(
      /No saved items for 2026-W43; run it once without a variant first./,
    );
    expect(h.buildApp).not.toHaveBeenCalled();
  });

  it('Ctrl+C in the menu runs nothing and exits 1', async () => {
    const cancelled = Object.assign(new Error('closed'), { name: 'ExitPromptError' });
    const h = week({
      prompts: { select: () => Promise.reject(cancelled), input: vi_unused, confirm: vi_unused },
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toBe('Cancelled. Nothing was run.\n');
    expect(h.buildApp).not.toHaveBeenCalled();
    expect(h.runDigest).not.toHaveBeenCalled();
  });
});

function vi_unused(): never {
  throw new Error('not asked');
}

describe('runCommand: when there is no menu', () => {
  it('asks nothing without a terminal', async () => {
    const h = week({ interactive: false });

    await runCommand({}, h.deps);

    expect(h.calls).toEqual([]);
    expect(h.runDigest).toHaveBeenCalledWith(h.appDeps, {
      sinceDays: undefined,
      dryRun: undefined,
      force: undefined,
    });
  });

  it('asks nothing under --force', async () => {
    const h = week();

    await runCommand({ force: true }, h.deps);

    expect(h.calls).toEqual([]);
    expect(h.runDigest.mock.calls[0]?.[1].force).toBe(true);
  });

  it('asks nothing when the week has no sent or dry-run digest', async () => {
    const h = week();
    h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, status: 'failed' }));

    await runCommand({}, h.deps);

    expect(h.calls).toEqual([]);
  });

  it('asks nothing for a first run of the week', async () => {
    const h = week();
    h.store.records.clear();

    await runCommand({}, h.deps);

    expect(h.calls).toEqual([]);
  });

  it('refuses two variant flags before building the app', async () => {
    const h = week();

    const code = await runCommand({ enrich: true, complete: true }, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toMatch(/--enrich and --complete/);
    expect(h.buildApp).not.toHaveBeenCalled();
  });
});

describe('runCommand: a variant flag', () => {
  const flagged = (options: RunCommandOptions, setup: Setup = {}) => {
    const h = week({ interactive: false, slug: 'complete', ...setup });
    return { h, run: () => runCommand(options, h.deps) };
  };

  it('--complete skips the menu and, without a terminal, sends without asking', async () => {
    const email = new CapturingDelivery('email');
    const { h, run } = flagged(
      { complete: true },
      { deliveries: [new CapturingDelivery('markdown'), email] },
    );

    expect(await run()).toBe(0);

    expect(h.calls).toEqual([]);
    expect(email.digests).toHaveLength(1);
    expect(text(h.out)).toMatch(/Sent to email\./);
  });

  it('--dry-run builds it and sends nothing', async () => {
    const email = new CapturingDelivery('email');
    const { run } = flagged(
      { complete: true, dryRun: true },
      { deliveries: [new CapturingDelivery('markdown'), email] },
    );

    expect(await run()).toBe(0);

    expect(email.digests).toEqual([]);
  });

  it('--perspective works on a week without a menu (a failed week with items)', async () => {
    const { h, run } = flagged({ perspective: '"security"' }, { slug: 'perspective-security' });
    h.store.records.set(WEEK, makeRunRecord({ runId: WEEK, status: 'failed' }));

    await run();

    expect(h.runDigest.mock.calls[0]?.[1].variant).toMatchObject({
      kind: 'perspective',
      topic: 'security',
      keepUrls: [],
    });
  });

  it('--add-source without a terminal does not save and says how to keep them', async () => {
    const { h, run } = flagged({ addSource: ['https://new.example.com/feed'] });

    await run();

    expect(h.calls).toEqual([]);
    expect(h.written.size).toBe(0);
    expect(text(h.out)).toMatch(
      /Sources added for this run only\. Add them to \/work\/digest\.config\.json/,
    );
  });

  it('--add-source with a bad URL stops before the app is built', async () => {
    const { h, run } = flagged({ addSource: ['nope'] });

    expect(await run()).toBe(1);

    expect(text(h.err)).toMatch(/Invalid --add-source/);
    expect(h.buildApp).not.toHaveBeenCalled();
  });
});

describe('runCommand: sending a variant', () => {
  const channels = () => ({
    markdown: new CapturingDelivery('markdown'),
    email: new CapturingDelivery('email'),
    slack: new CapturingDelivery('slack'),
  });

  it('asks "Send to email, slack?", and No (Enter) leaves the files only', async () => {
    const c = channels();
    const h = week({ rules: [pick('complete')], deliveries: [c.markdown, c.email, c.slack] });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(h.calls.at(-1)?.message).toBe('Send to email, slack?');
    expect(c.markdown.digests).toHaveLength(1);
    expect(c.markdown.digests[0]?.variant).toBe('enriched');
    expect(c.email.digests).toEqual([]);
    expect(h.store.records.get(WEEK)?.variant).toBeUndefined();
  });

  it('Yes ships to the non-Markdown channels and updates the record', async () => {
    const c = channels();
    const h = week({
      rules: [pick('complete'), [/Send to/, true]],
      deliveries: [c.markdown, c.email, c.slack],
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(c.email.digests).toHaveLength(1);
    expect(c.slack.digests).toHaveLength(1);
    expect(c.markdown.digests).toHaveLength(1);
    expect(h.store.records.get(WEEK)).toMatchObject({
      status: 'sent',
      deliveredTo: ['markdown', 'email', 'slack'],
      variant: { kind: 'complete' },
    });
  });

  it('a channel that fails exits 1 and names the channel that missed', async () => {
    const c = channels();
    c.email.failWith = new Error('smtp down');
    const h = week({
      rules: [pick('complete'), [/Send to/, true]],
      deliveries: [c.markdown, c.email, c.slack],
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toMatch(/email \(smtp down\)/);
    expect(text(h.err)).toMatch(/Not sent to: email\./);
    expect(c.slack.digests).toHaveLength(1);
  });

  it('does not ask when only the Markdown file is configured', async () => {
    const h = week({ rules: [pick('complete')] });

    await runCommand({}, h.deps);

    expect(h.calls.map((c) => c.message)).not.toContain(expect.stringMatching(/Send to/));
  });

  it('--dry-run skips the question', async () => {
    const c = channels();
    const h = week({ rules: [pick('complete')], deliveries: [c.markdown, c.email] });

    await runCommand({ dryRun: true }, h.deps);

    expect(h.calls.map((call) => call.message)).toEqual([
      'Week 2026-W43 already has a sent digest. What now?',
    ]);
    expect(c.email.digests).toEqual([]);
  });

  it('Ctrl+C at the send question sends nothing and keeps the build exit code', async () => {
    const c = channels();
    const cancelled = Object.assign(new Error('closed'), { name: 'ExitPromptError' });
    const h = week({
      deliveries: [c.markdown, c.email],
      prompts: {
        select: () => Promise.resolve('complete' as never),
        input: vi_unused,
        confirm: () => Promise.reject(cancelled),
      },
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(text(h.err)).toMatch(/Cancelled\. Nothing was sent\./);
    expect(c.email.digests).toEqual([]);
  });

  it('a failed local copy exits 1 and says where', async () => {
    const markdown = new CapturingDelivery('markdown');
    markdown.failWith = new Error('disk full');
    const h = week({ rules: [pick('complete')], deliveries: [markdown] });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toMatch(/could not write the complete digest to .*: disk full/);
  });
});

describe('runCommand: a variant that builds no digest', () => {
  it('prints why and returns the run code', async () => {
    const h = week({ rules: [pick('enrich')] });
    h.runDigest.mockResolvedValue({
      ...sentResult({ status: 'blocked' }),
      exitCode: 2,
      markdown: undefined,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(2);
    expect(text(h.err)).toMatch(/No enriched digest was built \(status: blocked\)/);
  });
});

describe('runCommand: the summary of a variant', () => {
  it('prints a Variant line', async () => {
    const h = week({ rules: [pick('complete')], slug: 'complete' });

    await runCommand({}, h.deps);

    expect(text(h.out)).toMatch(/Variant {3}complete/);
  });
});
