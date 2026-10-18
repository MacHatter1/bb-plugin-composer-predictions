---
name: composer-predictions
description: Inspect, regenerate, or dismiss a thread's Composer Predictions suggestion (the ghost text in an empty message box) with `bb composer-predictions`. Use when the user asks why a suggestion is or isn't showing, wants a fresh one, or wants one cleared.
---

# Composer Predictions

Composer Predictions suggests the user's next message as ghost text in an
empty thread composer after an agent reply. **Tab** or a right swipe inside the message box inserts it as an editable
draft. It never sends anything. Each prediction is one request to a hidden
helper thread, stopped and then archived once its answer is used or the
conversation moves on. Providers that support archive get that chat archived
too. It never posts to the user's thread.

## Commands

Every command takes a thread id (`bb status` shows the current one) and an
optional `--json`. Without `--json`, the output is the suggestion text, or the
status when there is no suggestion.

```sh
bb composer-predictions show <thread-id> [--json]        # current state; starts nothing
bb composer-predictions regenerate <thread-id> [--json]  # discard and predict again
bb composer-predictions dismiss <thread-id> [--json]     # hide the current suggestion
```

`regenerate` returns at once, usually with `generating`. Run `show` again a
few seconds later.

## Reading the status

| Status | Meaning |
| --- | --- |
| `ready` | A suggestion is waiting in the composer. |
| `generating` | A helper is working on it. |
| `abstained` | The model found no grounded next message and chose to suggest nothing. |
| `dismissed` | The user typed, pasted, pressed Escape, or accepted it. It stays hidden until the conversation changes. |
| `error` | The prediction failed. `bb plugin logs composer-predictions` has the cause, such as an unavailable model. |
| `idle` | Nothing to predict, or not requested yet. |

`idle` is normal when:

- the thread is running, has queued messages or background agents, or is
  hidden or archived. Your own thread is running during your turn, so `show`
  on it reports `idle` until you finish;
- the latest record in the conversation is not a completed agent message;
- the plugin is off (`bb plugin config composer-predictions`);
- BB or the plugin has restarted and the composer has not asked again yet.
  Saved suggestions are checked against the current conversation before they
  are shown.

## Rules

- Do not run `regenerate` repeatedly. Each run is a model request at normal
  provider cost.
- The plugin cannot send a message or write into the composer from the CLI.
  Only the user's Tab or right swipe inserts a suggestion.
- The prediction model is chosen in **Settings → Plugins → Composer
  Predictions → Prediction model**. Point the user there; there is no CLI for
  it.
- A provider that cannot approve automatically is still allowed when it can
  ask. BB then opens the helper beside the conversation and the suggestion
  waits. Answer there, or move the conversation on to cancel it. Providers
  that approve automatically stay hidden and are stopped if they ask.
