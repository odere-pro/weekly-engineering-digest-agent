import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { renderEmailHtml } from './email/emailHtml';
import { renderEmailText } from './email/emailText';
import { createSmtpDelivery, type MailMessage } from './smtp';
import type { DigestMessage } from '../Delivery';
import type { DigestView } from '../../render/digestView';
import { digestMessage } from '../../digest/ending/shipping/digestMessage';

// nodemailer's own stream transport builds the real MIME message in memory. No socket is opened.
const mimeBuilder = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

const view: DigestView = {
  weekId: '2026-W42',
  title: 'Week 2026-W42: 2 releases, 1 needs action',
  headline: 'Fixes & "news" <b>today</b>.',
  groups: [
    {
      urgency: 'act-now',
      label: 'Act now',
      items: [
        {
          title: 'Ollama v0.13.0',
          url: 'https://github.com/ollama/ollama/releases/tag/v0.13.0',
          whatChanged: 'Fixes a crash.',
          action: 'Upgrade.',
        },
      ],
    },
  ],
  footer: 'Naïve café — résumé ✓',
};

const message: DigestMessage = {
  weekId: '2026-W42',
  subject: 'Engineering digest 2026-W42',
  markdown: '# Digest\n',
};

async function buildMime(sent: DigestMessage): Promise<string> {
  const mails: MailMessage[] = [];
  const delivery = createSmtpDelivery({
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    user: 'digest@example.test',
    password: 'unused',
    from: 'Digest <digest@example.test>',
    to: ['me@example.test'],
    createTransport: () => ({
      sendMail: (mail) => {
        mails.push(mail);
        return Promise.resolve();
      },
    }),
  });
  await delivery.sendDigest(sent);
  const info = (await mimeBuilder.sendMail(mails[0]!)) as { message: Buffer };
  return info.message.toString('utf8');
}

describe('the digest email as nodemailer builds it', () => {
  it('is multipart/alternative with a text/plain and a text/html part when there is a view', async () => {
    const mime = await buildMime({ ...message, view });

    expect(mime).toMatch(/^Content-Type: multipart\/alternative;/m);
    const types = [...mime.matchAll(/^Content-Type: (text\/[a-z]+); charset=utf-8$/gm)].map(
      (match) => match[1],
    );
    expect(types).toEqual(['text/plain', 'text/html']);
  });

  it('puts the plain text first so a client that shows one part falls back to it', async () => {
    const mime = await buildMime({ ...message, view });

    expect(mime.indexOf('text/plain')).toBeLessThan(mime.indexOf('text/html'));
    expect(mime).toContain(`Subject: ${message.subject}`);
    expect(mime).toContain('To: me@example.test');
  });

  it('carries text and html that decode back to the renderer output', async () => {
    const mime = await buildMime({ ...message, view });

    const parts = decodeParts(mime);
    expect(parts.get('text/plain')).toBe(renderEmailText(view));
    expect(parts.get('text/html')).toBe(renderEmailHtml(view));
  });

  it('stays a single text/plain message without a view', async () => {
    const mime = await buildMime(message);

    expect(mime).not.toContain('multipart/alternative');
    expect(mime).not.toContain('text/html');
    expect(mime).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
  });
});

describe('the Subject of the digest email as nodemailer builds it', () => {
  /** Characters a reader cannot see but that reorder, hide or forge what is shown around them. */
  const INVISIBLE = /[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/u;
  const HOSTILE_HEADLINE =
    'Security fix \u202Egnirps\u202C \u2066x\u2069 \u200Bpatch\u0007 \u001B[31mRED';

  it('shows no invisible or control character of a hostile headline, in the header or decoded', async () => {
    const mime = await buildMime(digestMessage('2026-W42', HOSTILE_HEADLINE, '# Digest\n'));

    const subject = decodedSubject(mime);
    expect(subject).toBe('Engineering digest 2026-W42: Security fix gnirps x patch [31mRED');
    expect(INVISIBLE.test(subject)).toBe(false);
    expect(INVISIBLE.test(rawSubject(mime).replaceAll('\n', ''))).toBe(false);
  });

  it('keeps a plain ASCII headline readable in the header', async () => {
    const mime = await buildMime(digestMessage('2026-W42', 'Runners moved', '# Digest\n'));

    expect(decodedSubject(mime)).toBe('Engineering digest 2026-W42: Runners moved');
  });
});

/** The Subject header as written, unfolded: continuation lines start with whitespace. */
function rawSubject(mime: string): string {
  const header = mime.split('\n\n', 1)[0] ?? '';
  const lines = header.split('\n');
  const start = lines.findIndex((line) => line.startsWith('Subject:'));
  if (start < 0) return '';
  const folded = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break;
    folded.push(line);
  }
  return folded.join('\n').slice('Subject:'.length).trim();
}

/** The Subject a mail client shows: RFC 2047 encoded words (B or Q) decoded, parts joined. */
function decodedSubject(mime: string): string {
  const raw = rawSubject(mime).replaceAll(/\n[ \t]+/g, ' ');
  const joined = raw.replaceAll(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replaceAll(
    /=\?UTF-8\?([BQ])\?([^?]*)\?=/gi,
    (_word, encoding: string, text: string) =>
      encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : decodeQuotedPrintable(text.replaceAll('_', ' ')),
  );
}

/** Decodes the quoted-printable body of each text part of a MIME message, by content type. */
function decodeParts(mime: string): Map<string, string> {
  const result = new Map<string, string>();
  const partPattern =
    /Content-Type: (text\/[a-z]+); charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n([\s\S]*?)(?=\n----_|$)/g;
  for (const [, type, body] of mime.matchAll(partPattern)) {
    if (type !== undefined && body !== undefined) result.set(type, decodeQuotedPrintable(body));
  }
  return result;
}

function decodeQuotedPrintable(body: string): string {
  const latin1 = body
    .replaceAll('=\n', '')
    .replaceAll(/=([0-9A-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  return Buffer.from(latin1, 'latin1').toString('utf8');
}
