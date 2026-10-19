import { describe, expect, it } from 'vitest';
import { createLoadTracker } from './loadTracker';

describe('createLoadTracker', () => {
  it('calls every model cold until one has answered', () => {
    const loads = createLoadTracker();

    expect(loads.isCold('clef:latest')).toBe(true);
    expect(loads.isCold('granite4.1-guardian:8b')).toBe(true);
  });

  it('calls the model that answered last warm', () => {
    const loads = createLoadTracker();

    loads.markLoaded('clef:latest');

    expect(loads.isCold('clef:latest')).toBe(false);
    expect(loads.isCold('granite4.1-guardian:8b')).toBe(true);
  });

  it('forgets the earlier model: one model in memory at a time (OLLAMA_MAX_LOADED_MODELS=1)', () => {
    const loads = createLoadTracker();

    loads.markLoaded('clef:latest');
    loads.markLoaded('granite4.1-guardian:8b');

    expect(loads.isCold('clef:latest')).toBe(true);
    expect(loads.isCold('granite4.1-guardian:8b')).toBe(false);
  });

  it('keeps one tracker apart from another', () => {
    const first = createLoadTracker();
    const second = createLoadTracker();

    first.markLoaded('clef:latest');

    expect(second.isCold('clef:latest')).toBe(true);
  });
});
