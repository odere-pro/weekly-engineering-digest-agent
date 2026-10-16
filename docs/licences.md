# Model licences

Last checked: **2026-10-16**, against the primary sources linked below (publisher pages, the
licence files themselves, and the licence text each Ollama tag ships).

This is a reading of public pages, **not legal advice**. If a licence matters for your use, read
it yourself or ask a lawyer.

The repo (MIT, see [`LICENSE`](../LICENSE)) ships model **tags only**, never weights. Each user
pulls the models from Ollama and accepts each model's licence there. Every model the plan uses
allows commercial use.

## Licence table

| Model (tag used)                                | Licence                                                                                                | Commercial use    | Primary source                                                                                                                                                                                                                                                         | Checked    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| clef (`clef:latest`)                            | Apache 2.0                                                                                             | Yes               | [Cloudflare/clef on Hugging Face](https://huggingface.co/Cloudflare/clef) (base `Qwen/Qwen3.8-27B`, also Apache 2.0)                                                                                                                                                   | 2026-10-16 |
| strands-decider (`strands-decider:2b-mlx-bf16`) | Apache 2.0, base model Apache 2.0 (confirmed)                                                          | Yes               | [StrandsAgents/strands-decider-2B-qwen3.5-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610), its [`LICENSE.md`](https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610/blob/main/LICENSE.md)                          | 2026-10-16 |
| gemma4 (`gemma4:31b-mlx`, `gemma4:e4b-mlx`)     | Apache 2.0 (first Gemma release under it)                                                              | Yes               | [google/gemma-4-31B-it](https://huggingface.co/google/gemma-4-31B-it), [Google Open Source Blog](https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html)                                                                       | 2026-10-16 |
| nemotron-3.5-lightning (`:30b-mlx`)             | **Two different texts, see below:** OpenMDW 1.1 (NVIDIA) or NVIDIA Open Model Agreement (Ollama build) | Yes, under either | [NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16), [OpenMDW 1.1](https://openmdw.ai/license/1-1/), [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/) | 2026-10-16 |
| granite4.1-guardian (`granite4.1-guardian:8b`)  | Apache 2.0                                                                                             | Yes               | [ibm-granite/granite-guardian-4.1-8b](https://huggingface.co/ibm-granite/granite-guardian-4.1-8b)                                                                                                                                                                      | 2026-10-16 |
| qwen3.8 (`qwen3.8:27b-mlx`, optional)           | Apache 2.0                                                                                             | Yes               | [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) (and its [`LICENSE`](https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE))                                                                                                                           | 2026-10-16 |
| tev1 (excluded)                                 | None published: "being finalized"; no licence field or file in the repo                                | Unknown           | [togethercomputer/Tev1-4B-experimental](https://huggingface.co/togethercomputer/Tev1-4B-experimental) (README, "License")                                                                                                                                              | 2026-10-16 |
| nimble-v3 (excluded)                            | CC BY-NC 4.0                                                                                           | **No**            | [bespokelabs/Bespoke-Nimble-9B-v3](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B-v3), [Ollama](https://ollama.com/library/nimble-v3)                                                                                                                            | 2026-10-16 |

How each row was checked:

- **Hugging Face API metadata and the repo's licence file**, for every model that has one.
- **The licence layer in the Ollama registry manifest** of the exact tag, which is the text a user
  receives on `ollama pull`; `ollama show --license <tag>` prints it. Run on the tags already
  pulled locally: nemotron, strands-decider and clef print the texts described here, `tev1:4b`
  prints nothing. (clef's registry manifest lists no licence layer, yet the local copy prints
  Apache 2.0.)
- Ollama's own model pages often name no licence (gemma4, qwen3.8, nemotron), so they are not
  used as the source.

### Changes from the spec's table

- Secondary sources (RuntimeWire, eWeek) are replaced by the publishers' own pages.
- **strands-decider:** the base model is confirmed. The model is a LoRA adapter plus a decision
  head on `Qwen/Qwen3.5-2B-Base`, which is Apache 2.0 (Hub licence tag and `LICENSE`). The
  strands-decider `LICENSE.md` says so itself, and the Ollama package includes a copy of the Qwen
  Apache 2.0 text as a second licence layer. The spec's guess ("Qwen3.5-4B is Apache 2.0, so the
  2B likely is too") was right, but it was the 2B base that needed checking.
- **nemotron-3.5-lightning:** the licence is not one text. See the next section.

## Nemotron: read before the repo goes public

### What OpenMDW 1.1 says

Read in full (about 400 words). The text is identical in NVIDIA's Hugging Face repos (BF16 and
NVFP4), the [OpenMDW GitHub repo](https://github.com/OpenMDW/OpenMDW), and on
[openmdw.ai](https://openmdw.ai/license/1-1/). NVIDIA's model card also says "This model is ready
for commercial use."

- **Grant:** free of charge, permission to deal in the Model Materials "without restriction",
  covering copyright, patent, database and trade-secret rights.
- **Redistribution:** if you distribute any portion, keep a copy of the agreement and the
  copyright and origin notices that apply. No copyleft, no share-alike.
- **Patent/copyright litigation:** your rights end if you sue anyone claiming the Model Materials
  infringe a patent or copyright, unless that was a response to a suit brought against you first.
- **Outputs:** no restrictions or obligations on outputs.
- **No** field-of-use limits, acceptable-use policy, trademark clause, guardrail clause or
  indemnity.
- **As-is:** no warranty; you are responsible for clearing third-party rights in the materials.

### The discrepancy

NVIDIA publishes the model under OpenMDW 1.1, but **the text Ollama ships with the tag is a
different NVIDIA licence**, and it differs between tags:

| Ollama tag                                          | Licence layer shipped                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `nemotron-3.5-lightning:30b-mlx` (used by the plan) | NVIDIA Open Model Agreement, release date April 2, 2026 (`v. March 9, 2026`) |
| `nemotron-3.5-lightning:latest`, `:30b`             | NVIDIA Open Model License Agreement, last modified October 24, 2025          |

The first matches [the text on nvidia.com](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/).
Neither is OpenMDW 1.1. The Ollama library page for the model names no licence at all. I could not
tell from public pages why they differ (a conversion by Ollama of a different NVIDIA release, or a
licence layer that was not updated). All three texts allow commercial use.

Terms of the **NVIDIA Open Model Agreement** (the one on the `30b-mlx` tag, read in full):

- Commercially usable; you may create and distribute derivative works; NVIDIA claims no
  ownership of outputs.
- Redistribution: give recipients a copy of the agreement; keep source-form notices; if the work
  has a `NOTICE` file, derivative works carry "Licensed by NVIDIA Corporation under the NVIDIA
  Open Model Agreement".
- Rights end if you sue claiming the work or an output infringes a patent or copyright.
- No use of NVIDIA trademarks beyond describing the origin.
- **You indemnify NVIDIA** against third-party claims from your use or distribution (not in
  OpenMDW).
- Delaware law, Santa Clara County courts, export and sanctions compliance.

The older **NVIDIA Open Model License Agreement** (`latest`, `30b`) is stricter: your rights end
automatically if you bypass or weaken a model guardrail, use must follow NVIDIA's Trustworthy AI
terms, NVIDIA may update the agreement (you must comply or stop), and it has the same
indemnity. The plan does not use those tags.

## Obligations for this repo

The repo distributes no model weights, so none of the redistribution conditions above are
triggered by publishing it. They apply to whoever downloads and passes on the weights. What the
repo should do:

1. **Ship tags only.** Do not add weights, quantised copies, or fine-tunes to the repo, the
   Docker image or a release. If that ever changes, keep each model's licence text and notices
   with it (Apache 2.0: `LICENSE` and any `NOTICE`; OpenMDW: the agreement and origin notices;
   NVIDIA Open Model Agreement: the agreement and the `NOTICE` line above).
2. **README table.** Publish the table above (model, licence, commercial use, source) and the
   sentence that users accept each licence when they `ollama pull`. Say the table is a reading of
   public pages, not legal advice, and give the check date.
3. **Nemotron row.** Do not write only "OpenMDW 1.1" in the README. Suggested wording: "OpenMDW 1.1
   on NVIDIA's own release; the Ollama build ships the NVIDIA Open Model Agreement. Both allow
   commercial use. Run `ollama show --license nemotron-3.5-lightning:30b-mlx` for the text you
   accepted." The spec's table row should be updated the same way.
4. **Pin the tag.** Keep the exact tag `nemotron-3.5-lightning:30b-mlx` in the profiles. The
   `latest` and `30b` tags carry the stricter 2025 text, so a user who swaps them in accepts
   different terms.
5. **Recheck at each release,** as the spec's risk table says, and again if an Ollama tag's
   licence layer changes. `ollama show --license <tag>` is the quickest check.
6. **Excluded models stay out.** `nimble-v3` is non-commercial (CC BY-NC 4.0); `tev1` has no
   published weights licence. Do not add either to a profile until that changes.

### Open points for the maintainer

- **Which NVIDIA text governs the Ollama build?** Public pages do not say. If it matters, ask
  NVIDIA or Ollama. Until then the README wording in point 3 is accurate under either reading.
- **strands-decider training data.** The weights are Apache 2.0, but the model's `LICENSE.md` notes
  that some training sources are ShareAlike (CC BY-SA, SQuAD 2.0, SNLI and others) or have
  custom terms, and tells readers to check a source's terms before redistributing data built from
  it. Using the model through Ollama does not redistribute that data. Nothing to do for a
  tags-only repo, but note it if the weights are ever bundled.

## Not covered

Licences of the npm dependencies, the terms of the RSS and GitHub sources in
[`sources.md`](sources.md), and the feed content stored in the repo's recorded eval weeks.
