# What it does

Part of [Overview](README.md).

Every week the agent reads a fixed list of engineering feeds and writes one short digest of the
3 to 5 AI and platform releases that matter to your team. It drops hype and minor releases,
checks its own draft, and delivers it as a Markdown file, an HTML page, an email or a Slack
message.

Everything runs on your own machine with [Ollama](https://ollama.com). There is no cloud, no API
key and no cost per run.

## The promises

| Promise    | What it means in practice                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Free       | The models run locally. A run costs electricity, nothing else.                                                                                 |
| Private    | Only feed requests and the delivery channels you turn on leave the machine.                                                                    |
| Guarded    | Feed text is untrusted. Fixed rules and models screen it before writing, and models check the drafts. See [safety](../architecture/safety.md). |
| Honest     | Every link in a digest comes from a collected item. Code checks this, not a prompt.                                                            |
| Short      | Each item says what changed and what to do. Items are grouped by urgency.                                                                      |
| Repeatable | A fixed seed and low temperature let a rerun of a week repeat itself.                                                                          |

## An example

```markdown
# Week 2026-W42: 5 releases, 1 needs action

_A security fix to ship now, and two platform releases to read_

## 🔴 Act now

| Release                                                                      | What changed                                                                          | What to do                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| [OpenTofu 1.12.8](https://github.com/opentofu/opentofu/releases/tag/v1.12.8) | Security fix: a crafted module source could read files outside the working directory. | Upgrade OpenTofu in CI and on laptops. |

## 🟡 Worth a look

| Release                                                                    | What changed                                                                       | Relevant if you                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| [Kubernetes 1.36](https://kubernetes.io/blog/2026/10/08/kubernetes-v1-36/) | Sidecar containers are stable and the last deprecated admission flags are removed. | run your own clusters or Helm charts. |

## ⚪ Good to know

| Release                                                    | What changed                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [Node.js 24.9](https://nodejs.org/en/blog/release/v24.9.0) | A routine release with fixes to the test runner and the HTTP client. |
```

The title line and the group labels come from code. Models only write the headline, the
summaries and the action lines. See [render](../features/render.md).

## The shape of a run

```text
collect -> guardInput -> classify -> process -> write -> guardOutput -> select -> deliver
```

Feeds go in on the left, one digest comes out on the right, and models do the judging while code
does the checking. The steps are explained in [data flow](../architecture/data-flow.md).

## Who it is for

- A team that wants a weekly read of platform and AI releases without reading 24 feeds.
- An engineer who wants to run local models on real work, with guards, checks and evals around
  them.

## Related

- [Cost and hardware](cost-and-hardware.md), [status and limits](status-and-limits.md)
- [Features](../features/README.md), [configuration](../configuration/README.md)
