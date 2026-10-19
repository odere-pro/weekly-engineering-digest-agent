// W5-12: RunOptions.notifyFailure reaches the ending of a run, whichever way the run fails.
import { describe, expect, it } from 'vitest';
import { requiredModels, type ModelProfile } from '../config/profiles';
import { runDigest } from './runDigest';
import { type DigestDeps, type RunOptions } from './types';
import { RunRecordSchema } from '../store/runRecord';
import type { ModelHealth } from '../models/ModelProvider';
import type { LogFields, Logger } from '../shared/telemetry';
import { makeConfig, makeRunRecord } from '../../test/builders';
import {
  CapturingDelivery,
  FakeInputGuard,
  FakeModelProvider,
  FakeOutputGuard,
  FakeSourceFetcher,
  MemoryRunStore,
  fixedClock,
  noopTracer,
} from '../../test/fakes';

const WEEK = '2026-W42';
const NOW = '2026-10-16T08:00:00Z';
const HELD_BACK = 'Failure note held back: notifyFailure is off for this run';

const PROFILE: ModelProfile = {
  name: 'quality',
  classify: 'classifier:2b',
  guardPolicy: 'policy:2b',
  guardRisk: 'risk:8b',
  writers: ['writer-a:31b'],
  judge: 'judge:9b',
  requiresAppleSilicon: false,
  minOllamaVersion: '0.0.0',
};

const DOWN: ModelHealth = { reachable: false, models: [], error: 'connection refused' };
const UP: ModelHealth = {
  reachable: true,
  version: '0.40.4',
  models: requiredModels(PROFILE).map((name) => ({ name, capabilities: [] })),
};

interface LogLine {
  message: string;
  fields: LogFields;
}

function recordingLogger(lines: LogLine[]): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: (message, fields = {}) => void lines.push({ message, fields }),
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

/** A run that fails at once: Ollama is down, so nothing is collected. */
function setup(health: ModelHealth = DOWN) {
  const logs: LogLine[] = [];
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const deps: DigestDeps = {
    config: makeConfig(),
    profile: PROFILE,
    model: new FakeModelProvider({ health }),
    fetchers: { rss: new FakeSourceFetcher('rss', {}) },
    inputGuards: [new FakeInputGuard('clefPolicy'), new FakeInputGuard('graniteRisk')],
    outputGuards: [new FakeOutputGuard('graniteGroundedness'), new FakeOutputGuard('clefRubric')],
    deliveries,
    store,
    logger: recordingLogger(logs),
    tracer: noopTracer,
    clock: fixedClock(NOW),
  };
  const run = (options: RunOptions = {}) => runDigest(deps, options);
  const runWith = (model: DigestDeps['model'], options: RunOptions = {}) =>
    runDigest({ ...deps, model }, options);
  const notes = () => deliveries.map((delivery) => delivery.failures.length);
  const held = () => logs.filter((line) => line.message === HELD_BACK);
  return { run, runWith, store, deliveries, notes, held };
}

describe('runDigest: notifyFailure', () => {
  it('sends the failure note of a failed run by default', async () => {
    const h = setup();

    const result = await h.run();

    expect(result.record.status).toBe('failed');
    expect(h.notes()).toEqual([1, 1]);
    expect(h.held()).toEqual([]);
  });

  it('sends it when notifyFailure is true', async () => {
    const h = setup();

    await h.run({ notifyFailure: true });

    expect(h.notes()).toEqual([1, 1]);
  });

  it('holds it back when notifyFailure is false, and still records the failure', async () => {
    const h = setup();

    const result = await h.run({ notifyFailure: false });

    expect(result.record.status).toBe('failed');
    expect(result.record.error?.message).toContain('Ollama is not reachable');
    expect(RunRecordSchema.parse(h.store.records.get(WEEK))).toEqual(result.record);
    expect(h.store.artifacts.get(`${WEEK}/error.json`)).toContain('Ollama is not reachable');
    expect(h.notes()).toEqual([0, 0]);
    expect(h.held()).toHaveLength(1);
  });

  it('releases the lock of a run whose note was held back', async () => {
    const h = setup();

    await h.run({ notifyFailure: false });

    expect(h.store.isLocked).toBe(false);
  });

  it('sends the note of a run that was told to stop, even when notifyFailure is false', async () => {
    const h = setup(UP);
    const controller = new AbortController();
    controller.abort(new Error('run timed out after 3 h'));

    const result = await h.run({ notifyFailure: false, signal: controller.signal });

    expect(result.record.error?.message).toBe('Run aborted: run timed out after 3 h');
    expect(h.notes()).toEqual([1, 1]);
    expect(h.held()).toEqual([]);
  });

  it('holds the note of a stopped run that failed for another reason: it goes by the failure', async () => {
    const controller = new AbortController();
    const h = setup(DOWN);
    // The signal fires during the health check, which then reports Ollama down.
    const stopping = new FakeModelProvider({ health: DOWN });
    stopping.health = () => {
      controller.abort(new Error('run timed out after 3 h'));
      return Promise.resolve(DOWN);
    };

    const result = await h.runWith(stopping, { notifyFailure: false, signal: controller.signal });

    expect(result.record.error?.message).toContain('Ollama is not reachable');
    expect(h.notes()).toEqual([0, 0]);
    expect(h.held()).toHaveLength(1);
  });

  it('sends the note of a resume that only --force can clear, even when notifyFailure is false', async () => {
    const h = setup(UP);
    // A week that reached markdown only; someone has since replaced its digest.md.
    h.store.records.set(
      WEEK,
      makeRunRecord({
        runId: WEEK,
        status: 'failed',
        deliveredTo: ['markdown'],
        sentUrls: ['https://example.com/posts/1'],
        error: { message: 'Delivery failed on email (SMTP delivery failed: 421)', step: 'deliver' },
      }),
    );
    h.store.artifacts.set(
      `${WEEK}/digest.md`,
      '# Another\n\n[Source](https://example.com/other)\n',
    );

    const result = await h.run({ notifyFailure: false });

    expect(result.record.status).toBe('failed');
    expect(result.record.error?.message).toContain('--force');
    expect(h.notes()).toEqual([1, 1]);
    expect(h.held()).toEqual([]);
  });

  it('holds back the note of a resume that failed on a channel, when notifyFailure is false', async () => {
    const h = setup(UP);
    h.store.records.set(
      WEEK,
      makeRunRecord({
        runId: WEEK,
        status: 'failed',
        deliveredTo: ['markdown'],
        sentUrls: ['https://example.com/posts/1'],
      }),
    );
    h.store.artifacts.set(
      `${WEEK}/digest.md`,
      '# Digest\n\n[Source](https://example.com/posts/1)\n',
    );
    const email = h.deliveries.find((delivery) => delivery.id === 'email');
    if (email) email.failWith = new Error('SMTP delivery failed: 451');

    const result = await h.run({ notifyFailure: false });

    expect(result.record.status).toBe('failed');
    expect(result.record.error?.message).toContain('email');
    expect(h.notes()).toEqual([0, 0]);
    expect(h.held()).toHaveLength(1);
  });

  it('sends nothing in a dry run, whatever notifyFailure says', async () => {
    const h = setup();

    await h.run({ dryRun: true, notifyFailure: true });

    expect(h.notes()).toEqual([0, 0]);
  });
});
