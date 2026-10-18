# Model licences

Checked on **2026-10-16** against the publishers' own pages and the licence text each Ollama
tag ships. This is a reading of public pages, **not legal advice**. If a licence matters for
your use, read it or ask a lawyer.

The repo (MIT, [`LICENSE`](../LICENSE)) ships model **tags only**, never weights. You accept each
model's licence when you run `ollama pull`. Every model a profile uses allows commercial use.

| Model (tag used)                                | Licence                                                                             | Commercial use    | Source                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| clef (`clef:latest`)                            | Apache 2.0                                                                          | Yes               | [Cloudflare/clef](https://huggingface.co/Cloudflare/clef) (base `Qwen/Qwen3.8-27B`, also Apache 2.0)                                          |
| strands-decider (`strands-decider:2b-mlx-bf16`) | Apache 2.0 (base `Qwen3.5-2B-Base`, Apache 2.0)                                     | Yes               | [StrandsAgents/strands-decider-2B-qwen3.5-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610)                   |
| gemma4 (`gemma4:31b-mlx`, `:e4b-mlx`, `:31b`)   | Apache 2.0                                                                          | Yes               | [google/gemma-4-31B-it](https://huggingface.co/google/gemma-4-31B-it)                                                                         |
| nemotron-3.5-lightning (`:30b-mlx`)             | OpenMDW 1.1 on NVIDIA's release; the Ollama build ships NVIDIA Open Model Agreement | Yes, under either | [NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16), [OpenMDW 1.1](https://openmdw.ai/license/1-1/) |
| granite4.1-guardian (`granite4.1-guardian:8b`)  | Apache 2.0                                                                          | Yes               | [ibm-granite/granite-guardian-4.1-8b](https://huggingface.co/ibm-granite/granite-guardian-4.1-8b)                                             |
| qwen3.8 (`qwen3.8:27b-mlx`, optional)           | Apache 2.0                                                                          | Yes               | [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B)                                                                                   |
| tev1 (excluded)                                 | None published                                                                      | Unknown           | [togethercomputer/Tev1-4B-experimental](https://huggingface.co/togethercomputer/Tev1-4B-experimental)                                         |
| nimble-v3 (excluded)                            | CC BY-NC 4.0                                                                        | **No**            | [bespokelabs/Bespoke-Nimble-9B-v3](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B-v3)                                                   |

`ollama show --license <tag>` prints the text a tag ships.

## Nemotron: pin the tag

NVIDIA publishes the model under OpenMDW 1.1, but the text Ollama ships differs by tag:

- `nemotron-3.5-lightning:30b-mlx` (used by `quality` and `fast`) ships the NVIDIA Open Model
  Agreement (April 2026). It allows commercial use and adds an indemnity of NVIDIA by you.
- `:latest` and `:30b` ship the older NVIDIA Open Model License Agreement. It is stricter: rights
  end if you bypass a guardrail, and NVIDIA may change the terms.

Keep the exact tag `nemotron-3.5-lightning:30b-mlx` in the profiles. Public pages do not say
which text governs the Ollama build. Recheck at each release with `ollama show --license`.

## Rules for this repo

1. Ship tags only. Never add weights or fine-tunes to the repo, the image or a release.
2. Do not add `nimble-v3` (non-commercial) or `tev1` (no published licence) to a profile.
3. Not covered here: npm dependency licences, the terms of the feeds in
   [`sources.md`](sources.md), and the feed content stored in the recorded eval weeks.
