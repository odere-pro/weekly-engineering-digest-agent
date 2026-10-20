# Shipping

> Sends the winning digest to every channel and builds the message they get. Entries:
> `shipDigest(channels, message, alreadyDelivered) → Shipped`, `winnerMessage(ctx, winner, fallback)`
> and `digestMessage(weekId, headline, markdown, view?)`. Port: `Delivery.sendDigest`.

## Flow

```mermaid
flowchart TD
  winner["winning CheckedDraft"] --> msg["winnerMessage: subject, Markdown, laid-out view"]
  msg --> ship["shipDigest"]:::focus
  ship --> each["forEachDelivery: one channel after the other, errors collected"]
  each -.->|"sendDigest"| ch[[Delivery]]
  each --> out{"any failed?"}
  out -->|no| ok["Shipped: deliveredTo"]
  out -->|yes| err["Shipped: deliveredTo and a DigestError naming both outcomes"]
  classDef focus stroke-width:3px
```

## Rules

- `shipDigest` never throws and tries every channel; one that fails does not stop the others.
  `deliveredTo` lists the channels that already had the digest, then the ones that took it now.
  `onDelivered` hears the channels so far after each success; it must not throw (`saveProgress`).
- The error names what failed and what got through, so a rerun sends only to the others:
  `Delivery failed on email (SMTP 554); delivered on markdown`.
- The subject is `Engineering digest <week>: <headline>`, the headline passed through `visibleLine`
  (one line, no invisible characters) and the whole subject cut to 120 characters. A blank headline
  leaves it out. The view is added only when there is one, so a channel without a view shows the
  Markdown.
- `winnerMessage` marks a template-only fallback in the view footer and names the guards that were off.
- `stopBeforeSending` runs last before a send: a fired signal (also a lost lock) or a record that
  another run delivered since the run began stops it with `Run aborted` (`isUnretriable`).

## Files

| File               | Role                                                          |
| ------------------ | ------------------------------------------------------------- |
| `shipping.ts`      | `shipDigest`, `forEachDelivery`, `Shipped`, `DeliveryFailure` |
| `digestMessage.ts` | `digestMessage`, `winnerMessage`, `WinnerContext`             |
| `sendGuard.ts`     | `stopBeforeSending`: the last check of `deliver` and a resume |

Tests sit next to each file; `digestMessage.winner.test.ts` covers `winnerMessage`.

## Gotchas

- `forEachDelivery` is also how `notes/` sends failure notes: keep it free of digest logic.
- `resume/` builds its message with `digestMessage` from the saved Markdown, so the subject must
  stay a function of week and headline only.
