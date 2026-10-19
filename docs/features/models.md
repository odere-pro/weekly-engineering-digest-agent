# Models

Part of [Features](README.md).

## What it is for

Every language-model call in the digest goes through one port, `ModelProvider`. The pipeline asks
for a role (classify, guardPolicy, guardRisk, write, judge), never for a model tag or a URL. This
keeps the steps free of any vendor. The Ollama details (endpoints, timeouts, retries, context
limits) live in one adapter.

## Where it sits

It is a supporting layer used by classify, guards, write and select, as shown in
[ports and adapters](../architecture/ports-and-adapters.md).

## What it does

- Offers two calls. `generate` returns free text, used for writing and for Granite Guardian.
  `decide` asks typed questions about a text (yes or no, a choice, a score) and returns
  probabilities, used by classify, the policy guards and the judge.
- Steps that need JSON use `generateStructured`: it sends the JSON schema, validates the reply and,
  if it is invalid, asks the same model once to repair it. A second failure fails the step.
- The Ollama adapter maps a role to a model tag through the profile. `generate` uses `/api/chat`
  (streamed); `decide` uses `/v1/systemone`.
- Time limit per attempt: classify 60 s, guardPolicy 60 s, guardRisk 120 s, judge 120 s, write
  600 s.
- Retries: 2 by default (0 to 5 allowed), with backoff from 1 s up to 10 s. Retried: timeouts,
  network and stream errors and HTTP 5xx. Not retried: 4xx, a bad payload, or a call you aborted.
- Thinking and sampling: `guardRisk` runs with thinking off by default (Granite otherwise spends
  about a minute per call). Temperature is 0.2 for `write` and 0 for every other role. The seed
  (default 42) goes with every generate call, so a re-run of a week repeats itself.
- A reply cut at the token limit is returned with a warning, and `generateStructured` repairs it.
- Asking for the `judge` role on a profile with no judge is an error by design.
- Health: reads Ollama's version and model list and never throws. `digest doctor` and the run's
  start-up check use it.
- Logs hold role, model, latency, attempts and token counts. Never a prompt or an answer.

## What you can configure

- `profile` (`quality`, `fast` or `light`) picks the model tags. See
  [profiles](../configuration/profiles.md) and the runbook
  [choose a profile and pull models](../runbooks/set-up/choose-profile-and-pull-models.md).
- `models.writers`, `models.timeoutsMs`, `models.retries`, `models.think`, `models.seed`,
  `models.temperature`. See [models](../configuration/models.md).
- `OLLAMA_URL` in `.env`. See [environment](../configuration/environment.md). In Docker it must not
  be `localhost`.
- `models.rescoreWithWriter` is off by default; on, the classify step re-scores the shortlist with
  the writer model, in `digest run` and `digest eval`.
- All keys: [config keys](../reference/config-keys.md).

## What can go wrong

- Ollama is not running or a model is not pulled. The run stops at the start with "Ollama is not
  reachable" or "missing models". See [failed run](../runbooks/debug/failed-run.md).
- A model is slow or the machine runs out of memory. See
  [slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md). Keep
  `OLLAMA_MAX_LOADED_MODELS=1` on a host Ollama.
- A model gives bad structured output twice: the step fails with a message naming it.
- To change or update tags, see [upgrade models](../runbooks/maintain/upgrade-models.md). Licences:
  [model licences](../reference/model-licences.md).

## Code and tests

- Folder: [src/models/](../../src/models/). Maintainer notes: [CLAUDE.md](../../src/models/CLAUDE.md).
- Port: [ModelProvider.ts](../../src/models/ModelProvider.ts). Adapters:
  [src/models/adapters/](../../src/models/adapters/) (Ollama chat and the decision endpoint).
- Tests sit next to the code. They inject a fake `fetch` that serves responses recorded from
  Ollama; no network. Tests against a real model are in [test/live](../../test/live/) and run only
  with `LIVE_OLLAMA=1`.

## Related

- Callers: [classify](classify.md), [guards](guards.md), [write](write.md), [select](select.md).
- [config](config.md) holds the profiles. [app](app.md) builds the provider and traces each call.
