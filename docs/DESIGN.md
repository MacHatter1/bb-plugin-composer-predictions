# Composer Predictions: design notes

How a suggestion is produced, stored and painted, and the limits of each
step. The [README](../README.md) is the short version.

## When a prediction is requested

The composer bridge asks for a prediction (`ensure`) when a thread's composer
is empty and the thread is not running. Only threads whose composer has asked
are watched; at most 1,000 are tracked at once. The watch list is held in
memory and is not shortened when a composer closes. A thread leaves it when it
is archived or deleted, when the cap evicts it, or when the plugin restarts.
Until then, every reply in that thread starts a prediction, whether or not its
composer is on screen, so the suggestion is ready on your return.

A thread qualifies when it is idle and visible, not archived or deleted, with
no queued messages and no active background agents. Its conversation must end
with a completed assistant message. The state is cleared when the thread
starts running, fails, is archived or deleted, queues or dispatches a message,
or asks for an interaction.

Duplicate requests for the same thread are coalesced into one job. At most two
helpers run at once; further jobs wait for a free slot. An accepted or
dismissed prediction does not reappear until the conversation changes or
regeneration is requested explicitly.

## Generation

By default, generation uses the source thread's provider and its last
execution model, at the first of `low`, `none` or `medium` that the model
supports, or else the model's default effort. A saved prediction model
overrides the provider, model, reasoning effort and service tier. If the saved
effort is not offered by the model, the model's default effort is used. A
separate model's provider receives the same reconstructed conversation,
including tool output, that the conversation's own provider would.

The chosen provider must support BB's `auto` permission mode, and the model
must be available on the source conversation's machine, including for SSH
conversations. An unavailable provider, model or service tier produces an
error. The plugin never silently substitutes another model.

Each prediction is a hidden helper thread in the same environment, titled
*Composer prediction helper* and marked in its plugin metadata. It makes one
prediction request. It does not continue the source conversation or submit a
message there. Helpers are archived and stopped after completion,
cancellation, failure, or a 60-second timeout. On startup, the plugin finds
its own marked, hidden, unarchived helpers left by an interrupted server
process and cleans them up. If that lookup fails, it logs a warning, cleans up
the helpers it could read, and loads anyway; the rest are found on the next
start. A failed stop after a helper asks for approval or input is also only
logged, because the helper's own cleanup stops it again. Normal provider usage
and billing apply.

The prediction instruction in `lib/prediction.ts` reproduces the
composer-predictions remote config v5 inspected on 16 October 2026. A
BB-specific wrapper asks for JSON matching `{"suggestion": string | null}` and
treats the quoted conversation as data. The parser accepts exactly one
`suggestion` field. A suggestion must be a single line of 1 to 240 characters;
control characters and Unicode line or paragraph separators are rejected.
`null` is an abstention.

## Context

The input is a chronological text reconstruction of up to 400 recent BB
events (four pages of 100): user inputs, completed assistant messages, and
completed tool records, including command arguments and output, MCP arguments
and results, and file-change records. Reasoning and binary payloads are
omitted, and `data:` URLs in tool records are replaced with a marker.

| Record | Limit |
| --- | --- |
| User message | 16,000 characters |
| Assistant message | 20,000 characters |
| Tool record | 5,000 characters, with each string field at most 4,000 |
| Whole conversation | `contextCharacters`, 48,000 by default (4,000–120,000) |

When a record or the whole conversation is truncated, the first fifth and the
latest four fifths are kept, joined by a `[content omitted]` marker.

This is a BB event reconstruction, not a native provider session fork. The
helper also receives the provider's usual environment and agent instructions.
BB retains the helper's history, including the quoted conversation, as an
archived hidden thread.

## Tools and permissions

The helper is instructed not to call tools or take actions. It runs in BB's
`auto` permission mode, and it is stopped if it asks for an interaction,
including one raised before `spawn()` returns. The plugin selects no tools or
skills of its own for the helper. The SDK's plugin-local `tools: []` does not
remove BB's core tools or other plugins' tools, so this is not a tool-free
provider sandbox.

## Persistent cache

Completed predictions survive BB restarts and plugin reloads. Each entry is
stored in the plugin's own BB-managed SQLite database: the suggestion, its
status (`ready`, `abstained` or `dismissed`), the generation ID, the model,
the context length, and a fingerprint. The conversation text itself is not
stored.

The fingerprint is a SHA-256 hash covering the conversation text, the latest
relevant event sequence, the prediction prompt and worker instructions, the
resolved provider, model, reasoning effort and service tier, the context
budget, and the source project and environment. A changed thread or model
cannot reuse an old prediction.

On returning to a thread, the plugin rebuilds and fingerprints the current
context before it shows a saved result. A matching fingerprint reuses the
saved prediction without another model request. Accepted or dismissed
suggestions and abstentions are also restored, so they are not offered or
generated again for the same context.

- **Not saved:** errors and unfinished generations.
- **Cleared:** every entry, when a setting or the prediction model changes.
- **Bounded:** at most 1,000 thread entries; the oldest are evicted first.
- **Self-checking:** a malformed or mismatched record is deleted on read.

A temporary failure while checking a saved result keeps the entry on disk for
a later healthy retry, without displaying unvalidated text. Typing during the
check suppresses predictions immediately while the read-only lookup finishes,
so the dismissal is saved against the current conversation rather than the
saved one. A dismissal that carries the temporary generation ID from before
restoration still applies to the restored result. Later generations remain
protected from stale dismissals.

## UI and compatibility

A composer customisation, scoped to threads, adds an invisible bridge to the
composer's banner area. The bridge holds the composer handle and a polite live
region that announces *Suggestion available. Press Tab to insert: …* to
screen readers. A trusted content script finds the editor inside that
bridge's own composer shell and paints an inert, theme-aware overlay beside
the editor, outside the editor document. The overlay is clamped to one line in
the compact composer and three lines otherwise, and it hides during voice
input.

Only a plain **Tab** received by that editor while a suggestion is visible is
handled. **Shift**, **Alt**, **Ctrl** or **Cmd** with Tab, a Tab the host has
already handled, and Tab during IME composition are left alone. **Escape**,
typing, pasting and dropping dismiss the suggestion. Acceptance calls the
public `composer.replace` and `composer.focus` APIs, and only fills a draft
with no text, mentions or attachments. The frontend has no call to
`composer.submit`.

BB has no first-class ghost-text slot yet, so placement relies on BB 0.46
composer DOM attributes (`data-promptbox-shell`, `data-promptbox-editor-content`,
`data-promptbox`, `data-promptbox-voice-active`). If the editor cannot be
matched uniquely to its own bridge, the overlay is removed and Tab is not
captured. A change to BB's composer markup may need a plugin update. Unloading
the plugin removes overlays, key listeners, styles and observers.

## Review records

Each release was reviewed and verified against a live BB 0.46.1. The records
are in [reviews/](reviews/):

- [0.1.0 verification](reviews/0.1.0-verification.md)
- [0.1.1 bug review](reviews/0.1.1-review.md)
- [0.2.0 model settings and icon](reviews/0.2.0-verification.md)
- [0.3.0 persistence](reviews/0.3.0-verification.md)
- [0.3.1 persistence review](reviews/0.3.1-persistence-review.md)
