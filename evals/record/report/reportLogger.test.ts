import { describe, expect, it } from 'vitest';
import { reportLogger } from './reportLogger';

const TOKEN = 'ghp_recorder-token-5d21';

function loggerAndLines(githubToken?: string) {
  const lines: string[] = [];
  const logger = reportLogger((line) => lines.push(line), { githubToken });
  return { logger, lines };
}

describe('reportLogger', () => {
  it('turns a warning into a WARNING line with its fields as key=value', () => {
    const { logger, lines } = loggerAndLines();

    logger.warn('Skipped feed entries', { sourceId: 'feed-a', failed: 1, of: 2 });

    expect(lines).toEqual(['WARNING: Skipped feed entries (sourceId=feed-a failed=1 of=2)']);
  });

  it('turns an error into an ERROR line', () => {
    const { logger, lines } = loggerAndLines();

    logger.error('Could not read', { sourceId: 'feed-a' });

    expect(lines).toEqual(['ERROR: Could not read (sourceId=feed-a)']);
  });

  it('keeps info and debug lines out of the report', () => {
    const { logger, lines } = loggerAndLines();

    logger.info('Entry page could not be read', { sourceId: 'feed-a' });
    logger.debug('Retrying source', { sourceId: 'feed-a' });

    expect(lines).toEqual([]);
  });

  it('leaves a message without fields as it is', () => {
    const { logger, lines } = loggerAndLines();

    logger.warn('Feed is odd');
    logger.warn('Feed is odd', {});

    expect(lines).toEqual(['WARNING: Feed is odd', 'WARNING: Feed is odd']);
  });

  it('shows strings as they are and other values as JSON', () => {
    const { logger, lines } = loggerAndLines();

    logger.warn('Counted', { entries: 3, tags: ['a', 'b'], nothing: null, flag: false, id: 'x y' });

    expect(lines).toEqual([
      'WARNING: Counted (entries=3 tags=["a","b"] nothing=null flag=false id=x y)',
    ]);
  });

  it('adds the fields of a child logger, nested ones too, before the call fields', () => {
    const { logger, lines } = loggerAndLines();

    logger.child({ step: 'collect' }).child({ attempt: 2 }).error('Could not read', {
      sourceId: 'feed-a',
    });

    expect(lines).toEqual(['ERROR: Could not read (step=collect attempt=2 sourceId=feed-a)']);
  });

  it('lets the fields of a call win over those of the child logger', () => {
    const { logger, lines } = loggerAndLines();

    logger.child({ sourceId: 'bound' }).warn('Again', { sourceId: 'called' });

    expect(lines).toEqual(['WARNING: Again (sourceId=called)']);
  });

  it('does not change the logger a child was made from', () => {
    const { logger, lines } = loggerAndLines();

    logger.child({ step: 'collect' });
    logger.warn('Plain');

    expect(lines).toEqual(['WARNING: Plain']);
  });

  it('prints each warning as one line, whatever a feed put in the error text', () => {
    const { logger, lines } = loggerAndLines();

    logger.warn('Skipped\nentry', { firstError: 'bad\n  entry\r\nhere' });

    expect(lines).toEqual(['WARNING: Skipped entry (firstError=bad entry here)']);
  });

  it('takes the GitHub token out of the message and the fields', () => {
    const { logger, lines } = loggerAndLines(TOKEN);

    logger.warn(`Cannot read ${TOKEN}`, { firstError: `HTTP 401 for ${TOKEN}` });

    expect(lines).toEqual(['WARNING: Cannot read [redacted] (firstError=HTTP 401 for [redacted])']);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('takes the token out of the fields a child logger carries', () => {
    const { logger, lines } = loggerAndLines(TOKEN);

    logger.child({ url: `https://x.example/?t=${TOKEN}` }).warn('Failed');

    expect(lines).toEqual(['WARNING: Failed (url=https://x.example/?t=[redacted])']);
  });
});
