# Delivery retries

Part of [Operations](README.md).

An email or Slack send is retried **twice**, after 5 and 10 seconds. It is retried only when
sending again cannot double the message.

## Retried

- Connect-phase network errors (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
  `ENETUNREACH`, DNS errors, connect timeouts)
- SMTP connect, greeting and upgrade timeouts
- HTTP 429 and 5xx from Slack
- SMTP 421, 450 and 451

## Not retried

Any other error fails the channel at once. So does a connection reset or a socket timeout
**after** the body went out: the server may have taken the message. That is why delivery is at
least once: a message can still arrive twice.

## What a failed channel does

- The run keeps going to the other channels and ends `failed` at `deliver`.
- `deliveredTo` in `run.json` lists the channels that got the digest.
- A failure note goes to every channel.
- The next `digest run` for that week sends the saved `digest.md` to the missing channels only.
  See [resume a partial delivery](../runbooks/recover/resume-partial-delivery.md).

## Every retry sends the same redacted message

Redaction wraps the retry, so no retry carries a secret the first send did not. See
[safety](../architecture/safety.md).

## Related

- [Failed delivery](../runbooks/debug/failed-delivery.md)
- [Delivery feature](../features/delivery.md), [app feature](../features/app.md)
