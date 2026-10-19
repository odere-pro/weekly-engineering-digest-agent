import { describe, expect, it } from 'vitest';
import { releaseKeyOf } from './releaseKey';

/** Both titles report the same release, so a second source must collapse into the first. */
function sharesRelease(first: string, second: string): boolean {
  const key = releaseKeyOf(first);
  return key !== '' && key === releaseKeyOf(second);
}

describe('releaseKeyOf: the key of one title', () => {
  // Real titles from the feeds and releases the digest reads. '' means "not a release post".
  it.each([
    // The product is what comes before the version, minus filler like "Announcing".
    ['Announcing etcd v3.7.0', 'etcd@3.7'],
    ['etcd v3.7.0', 'etcd@3.7'],
    ['Announcing: Aspire 13.5 has shipped', 'aspire@13.5'],
    ['Gateway API v1.6: TCPRoute and UDPRoute Graduate to Standard', 'gateway api@1.6'],
    ['Claude Haiku 5.5 is now available on AWS ', 'claude haiku@5.5'],
    ['Claude Haiku 5.5 is now available on AWS GovCloud (US)', 'claude haiku@5.5'],
    ['Muse Spark Open 1.0 is now on Hugging Face', 'muse spark open@1.0'],
    ['Announcing Muse Spark Open v1.0 on Amazon SageMaker JumpStart', 'muse spark open@1.0'],
    ['Granite Switch 4.1: Chat, Decisions, and Speech from One Endpoint', 'granite switch@4.1'],
    ['GLM-5.2: Built for Long-Horizon Tasks', 'glm@5.2'],
    ['Arm & ExecuTorch 0.7: Bringing Generative AI to the masses', 'arm executorch@0.7'],
    ['CinePile 2.0 - making stronger datasets with adversarial refinement', 'cinepile@2.0'],
    ['Kubernetes v1.34: Of Wind & Will', 'kubernetes@1.34'],
    ['transformers v5.20.0: Release v5.20.0', 'transformers@5.20'],
    ['Gradio 3.0 is Out!', 'gradio@3.0'],
    // A bare version, with nothing after it, is still the release.
    ['Go 1.27', 'go@1.27'],
    ['Codestral 25.01', 'codestral@25.01'],
    // A trailing .0 is the same release; a prerelease suffix keeps its own identity.
    ['Accelerate 1.0.0', 'accelerate@1.0'],
    ['ollama v0.12.0', 'ollama@0.12'],
    ['Announcing etcd 3.7.0-beta.0', 'etcd@3.7.0-beta.0'],
    // Unicode is folded: a full-width letter and a dash do not change the product.
    ['Claude Code 2.1.5 released', 'claude code@2.1.5'],
    ['ｃlaude-code v2.1.5', 'claude code@2.1.5'],
  ])('reads %j as %j', (title, key) => {
    expect(releaseKeyOf(title)).toBe(key);
  });

  // What follows the version names another product or story, or the title has no clean version.
  it.each([
    [
      'a model variant after the version',
      'Gemini 3.1 Pro: A smarter model for your most complex tasks',
    ],
    ['a model variant, hyphenated', 'Gemini 3.1 Flash-Lite: Built for intelligence at scale'],
    ['a size after the version', 'Deploy Meta Llama 3.1 405B on Google Cloud Vertex AI'],
    ['a model name after the version', 'Granite 4.0 Nano: Just how small can you go? '],
    [
      'a size and a noun after the version',
      'Granite 4.0 3B Vision: Compact Multimodal Intelligence',
    ],
    ['a product that continues the title', 'Diffusers welcomes Stable Diffusion 3.5 Large'],
    [
      'a second product in the title',
      'Announcing Codestral 25.08 and the Complete Mistral Coding Stack',
    ],
    ['a list of releases', 'Introducing Gemini 3.6 Flash, 3.5 Flash-Lite, and 3.5 Flash Cyber'],
    ['a version glued to the name', 'Holo3.1: Fast & Local Computer Use Agents'],
    [
      'a year-like version with a noun after it',
      'Amazon DCV releases version 2026.0 with RHEL 10 support',
    ],
    ['a second version (upgrade path)', 'Foo 1.2 is out, replacing 1.1'],
    ['a comparison of two versions', 'Postgres 17.1 vs 16.5 benchmark'],
    ['a version inside a longer word', 'Tool build1.2.3 notes'],
    ['a version followed by letters', 'Tool 1.2.3abc is out'],
    ['plain integers and years', 'Python 3 turns 2026'],
    ['a version and nothing else', 'v1.2.0'],
    ['a version and filler words only', 'Version 2.0'],
    ['no version at all', 'Muse Spark Open lands on Hugging Face'],
    ['a blank title', ''],
  ])('gives no key for %s', (_name, title) => {
    expect(releaseKeyOf(title)).toBe('');
  });
});

describe('releaseKeyOf: two titles of one story', () => {
  it.each([
    [
      'the same release on two platforms',
      'Muse Spark Open 1.0 arrives',
      'Muse Spark Open 1.0 now available',
    ],
    [
      'a blog post and a GitHub release tag',
      'Transformers 5.20.0 is out',
      'transformers v5.20.0: Release v5.20.0',
    ],
    ['a trailing .0', 'Ollama 0.12 is out', 'ollama v0.12.0'],
    ['"Introducing" and a plain post', 'Kubernetes 1.34 is out', 'Introducing Kubernetes 1.34'],
    ['nothing after the version', 'Tool 6.1', 'Tool 6.1 is out'],
    ['an announcement verb', 'Tool 6.1 ships today', 'Tool 6.1 released'],
    ['a subtitle after a colon', 'Tool 6.1: Fast Lane', 'Tool 6.1 is available'],
    ['a subtitle after a dash', 'Tool 6.1 - Fast Lane', 'Tool 6.1 is available'],
    ['a subtitle after an en dash', 'Tool 6.1 – Fast Lane', 'Tool 6.1 is available'],
    ['a subtitle after an em dash', 'Tool 6.1 — Fast Lane', 'Tool 6.1 is available'],
    ['only punctuation after the version', 'Tool 6.1.', 'Tool 6.1 is available'],
    ['a platform the release landed on', 'Tool 6.1 on Platform A', 'Tool 6.1 now in Platform B'],
    ['the same version repeated in a subtitle', 'tool v6.1.0: Release v6.1.0', 'Tool 6.1 is out'],
    [
      'Unicode forms and punctuation in the name',
      'Claude Code 2.1.5 released',
      'ｃlaude-code v2.1.5',
    ],
  ])('shares a key for %s', (_name, first, second) => {
    expect(sharesRelease(first, second)).toBe(true);
  });

  it.each([
    ['another version of the same product', 'Kubernetes 1.34 is out', 'Kubernetes 1.35 is out'],
    ['another product with the same version', 'Alpha 2.0 is out', 'Beta 2.0 is out'],
    ['a prerelease of the same version', 'Tool 1.2.0-rc1 is out', 'Tool 1.2.0 is out'],
    ['a patch release', 'Tool 1.2 is out', 'Tool 1.2.1 is out'],
    ['a different prefix before the product', 'Meta Muse Spark Open 1.0', 'Muse Spark Open 1.0'],
    ['model variants', 'Claude 3.5 Sonnet', 'Claude 3.5 Haiku'],
    [
      'model variants after an announcement',
      'Gemini 2.5 Pro is generally available',
      'Gemini 2.5 Flash-Lite is now in preview',
    ],
    ['model sizes', 'Llama 3.1 405B', 'Llama 3.1 8B'],
    ['model sizes with a hyphenated name', 'GPT-4.1 mini', 'GPT-4.1 nano'],
    ['model specializations', 'Qwen 2.5 Coder', 'Qwen 2.5 VL'],
    ['support in two libraries', 'Python 3.13 support in numpy', 'Python 3.13 support in pandas'],
    [
      'release notes and a security advisory',
      'Kubernetes 1.34 release notes',
      'Kubernetes 1.34 security advisory',
    ],
    ['a migration guide and the release', 'Foo 1.2 to 1.3 migration guide', 'Foo 1.2 released'],
    [
      'the release and a benchmark against another version',
      'Postgres 17.1',
      'Postgres 17.1 vs 16.5 benchmark',
    ],
    [
      'a version heading and a different product',
      'Whats new in 2.0 for LangChain',
      'Whats new in 2.0 for LlamaIndex',
    ],
    ['an upgrade path and the release', 'Foo 1.2 is out, replacing 1.1', 'Foo 1.2 is out'],
  ])('does not share a key for %s', (_name, first, second) => {
    expect(sharesRelease(first, second)).toBe(false);
  });
});

describe('releaseKeyOf: hostile titles', () => {
  it('stays fast on hostile titles', () => {
    const hostile = [
      `Tool ${'1.'.repeat(50_000)}x is out`,
      `Tool 1.2${'-'.repeat(50_000)}`,
      `Tool 1${'.0'.repeat(50_000)} is out`,
      `${'v1.2 '.repeat(20_000)}is out`,
    ];
    const started = performance.now();

    hostile.forEach(releaseKeyOf);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
