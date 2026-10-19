import { describe, expect, it } from 'vitest';
import { resumed } from './resumed';
import { ExitCode } from '../../domain/schemas';
import { makeRunRecord } from '../../../test/builders';
import type { CapturingDelivery } from '../../../test/fakes';
import { WEEK, contextFor } from '../__fixtures__/stageKit';

const URLS = ['https://example.com/runner-1', 'https://example.com/runner-2'];
const SAVED = `# Runners moved\n\n_Week ${WEEK}_\n\n## 1. Runner\n\n${URLS.map((url) => `[Source](${url})`).join('\n\n')}\n`;
const previous = makeRunRecord({
  runId: WEEK,
  status: 'failed',
  sentUrls: URLS,
  deliveredTo: ['markdown'],
  winner: 'writer-a:31b',
  error: { step: 'deliver', message: 'Delivery failed on email (SMTP 451)' },
});
const part = { previous, deliveredTo: previous.deliveredTo ?? [], markdown: SAVED };

describe('resumed', () => {
  it('sends the saved digest to the missing channel and returns it with exit code 0', async () => {
    const h = contextFor();

    const result = await resumed(h.ctx, part);

    expect(result.record).toMatchObject({ status: 'sent', deliveredTo: ['markdown', 'email'] });
    expect(result.exitCode).toBe(ExitCode.Sent);
    expect(result.markdown).toBe(SAVED);
    expect(result).not.toHaveProperty('message');
    expect(h.store.records.get(WEEK)).toEqual(result.record);
  });

  it('exits like a failed run, with no digest named, when the saved digest is refused', async () => {
    const h = contextFor();

    const result = await resumed(h.ctx, { ...part, markdown: undefined });

    expect(result.record).toMatchObject({ status: 'failed', deliveredTo: ['markdown'] });
    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.markdown).toBeUndefined();
    expect((h.deliveries as CapturingDelivery[]).map((d) => d.digests.length)).toEqual([0, 0]);
  });
});
