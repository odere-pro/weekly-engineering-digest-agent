import { describe, expect, it } from 'vitest';
import type { DigestAppendix } from '../../../render/digestView';
import { renderEmailHtml } from './emailHtml';
import { renderEmailText } from './emailText';
import { fullView, group, item, viewOf } from './__fixtures__/emailKit';

const APPENDIX: DigestAppendix = {
  title: 'Everything this week',
  groups: [
    {
      area: 'Models & <tools>',
      items: [
        { title: 'Runner <b>1</b>', url: 'https://e.test/a?x=1&y="2"', line: 'It ships.' },
        { title: 'Bad link', url: 'javascript:alert(1)', line: 'Nope.' },
      ],
    },
  ],
};
const plainView = viewOf([group('good-to-know', [item()])]);

describe('email variant label', () => {
  it('adds the label to the title only when the view has a variant', () => {
    const variant = { ...plainView, variant: 'enriched' };

    expect(renderEmailText(variant)).toMatch(new RegExp(`^${plainView.title} \\(enriched\\)\n`));
    expect(renderEmailHtml(variant)).toContain(`${plainView.title} (enriched)</h1>`);
    expect(renderEmailHtml(variant)).toContain(`${plainView.title} (enriched)</title>`);
    expect(renderEmailText(plainView)).not.toContain('(');
  });

  it('leaves a view without variant or appendix as it was', () => {
    expect(renderEmailHtml(fullView)).not.toContain('<h3');
    expect(renderEmailText(fullView)).not.toContain('Everything');
  });
});

describe('email appendix', () => {
  const view = { ...plainView, footer: 'Footer line', appendix: APPENDIX };

  it('follows the footer in both parts', () => {
    const html = renderEmailHtml(view);
    const text = renderEmailText(view);

    expect(html.indexOf('Footer line')).toBeLessThan(html.indexOf('Everything this week'));
    expect(text.indexOf('Footer line')).toBeLessThan(text.indexOf('Everything this week'));
  });

  it('escapes the text and links only http(s) urls in the HTML', () => {
    const html = renderEmailHtml(view);

    expect(html).toContain('Models &amp; &lt;tools&gt;');
    expect(html).toContain('Runner &lt;b&gt;1&lt;/b&gt;');
    expect(html).toMatch(/<a href="https:\/\/e\.test\/a\?x=1&amp;y=[^"]*" rel="noopener"/);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<b>1');
  });

  it('prints only http(s) urls in the text part', () => {
    const text = renderEmailText(view);

    expect(text).toContain('- Runner <b>1</b>: It ships.\n  https://e.test/a?x=1&y=%222%22');
    expect(text).not.toContain('javascript:');
  });
});
