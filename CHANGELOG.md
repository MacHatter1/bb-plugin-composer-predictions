# Changelog

All notable changes to Composer Predictions are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Plain → (ArrowRight) in the empty message box inserts the visible suggestion,
  like Tab. The hint now reads `Tab / →`. With modifiers, or once the draft has
  text, → moves the caret as usual.

## 0.4.6 - 2026-10-20

### Fixed

- Automatically delete BB prediction helpers when their source conversation moves
  on or a prediction is regenerated. Helpers are stopped and archived first.
  Startup also recovers stale helpers, including archived helpers and finished
  helpers from older versions; failed cleanup is retried on reload.
  Provider sessions are archived where supported, rather than permanently deleted.
- Run startup recovery in the background so a large helper backlog does not
  exceed BB's plugin loading timeout.

## 0.4.5 - 2026-10-19

### Fixed

- A right swipe starting in the padded composer text area accepts the
  suggestion instead of opening the sidebar. Vertical scrolling and pinch
  zoom remain available, and gestures on nested controls are ignored.
- The prediction model chooser tries each available provider that supports
  predictions, so an unavailable or failing default provider does not block
  other models. Catalogue failures appear in settings and plugin logs, and
  Retry refreshes discovery without changing the saved prediction model.

### Thanks

- Thanks to [@salemsayed](https://github.com/salemsayed) for fixing
  composer-padding swipes and documenting touch and iPad verification in
  [#7](https://github.com/MacHatter1/bb-plugin-composer-predictions/pull/7).
- Thanks to [@danieldan020991](https://github.com/danieldan020991) for the
  catalogue bug report and diagnostics in
  [#5](https://github.com/MacHatter1/bb-plugin-composer-predictions/issues/5).

## 0.4.4 - 2026-10-18

### Added

- Swipe right inside an empty touchscreen composer to accept the visible
  suggestion as an editable draft. The gesture never sends a message.
  Coarse primary pointers show a **Swipe →** hint; desktop users keep **Tab**.
- An optional prediction prompt evaluation runner with public regression
  fixtures and recorded results.

### Changed

- Prediction instructions prefer silence when work is already promised,
  running or complete, while retaining grounded approvals, clarifications
  and acceptance of concrete recommendations the user requested.

### Thanks

- Thanks to [@salemsayed](https://github.com/salemsayed) for mobile swipe
  acceptance, prediction prompt refinements and iPad verification in
  [#6](https://github.com/MacHatter1/bb-plugin-composer-predictions/pull/6).

## 0.4.3 - 2026-10-17

### Changed

- A prediction provider that cannot approve automatically can still be used,
  as long as it can ask for approval. The helper opens beside the conversation
  when it needs a decision, and the suggestion waits until you answer or the
  conversation moves on. Providers that approve automatically still run
  unattended and stop if they ask. Full Access is not used.

## 0.4.2 - 2026-10-17

### Fixed

- Prediction helpers are stopped and then archived once their answer is used
  or the conversation moves on, so providers that support thread archive get
  that chat archived too. The suggestion is shown without waiting for the
  provider. A failed archive is logged and retried on reload and on the next
  start.
- Startup cleanup releases finished helpers left from before this behaviour.
  The current conversation and a helper that is still running are left alone.

## 0.4.1 - 2026-10-16

### Fixed

- The plugin no longer fails to load when startup recovery cannot list or
  read its left-over helper threads. It logs a warning, cleans up the helpers
  it could read, and finds the rest on the next start.
- A helper that cannot be stopped after asking for approval or input no longer
  raises an event handler error. The failure is logged, and the prediction
  still ends in an error.

## 0.4.0 - 2026-10-16

### Added

- A bundled agent skill for `bb composer-predictions`, offered to ordinary
  threads. Prediction helpers still receive no skills.

### Changed

- Design notes and per-release review records moved to `docs/`.
- README screenshots of the ghost text, the inserted draft and the settings.
- The README and store listing now state that every reply in a watched thread
  costs one request, and that a separate prediction model's provider receives
  the conversation, including tool output.

## 0.3.1 - 2026-10-16

### Fixed

- A temporary failure while checking a saved prediction no longer deletes it.
  A later retry can restore it.
- A dismissal sent while a saved prediction was being restored now applies to
  the restored suggestion.
- Typing while a changed conversation was being checked now records the
  dismissal against the current conversation, so the suggestion does not
  return.

## 0.3.0 - 2026-10-16

### Added

- Ready suggestions, abstentions and dismissals persist across BB restarts and
  plugin reloads in the plugin's SQLite database. Each is checked against the
  current thread before it is shown, and no conversation text is stored.
- At most 1,000 saved thread entries; the oldest are evicted.

## 0.2.0 - 2026-10-16

### Added

- A **Prediction model** settings section with BB's native provider and model
  picker, reasoning effort and service tier, an explicit save, and a reset to
  each conversation's model.
- A custom input-field and text-cursor icon.

## 0.1.1 - 2026-10-16

### Fixed

- A delayed dismissal could cancel a newer prediction for the same
  conversation. Each attempt now has its own generation ID.
- Typing before the first prediction arrived could let it reappear after the
  draft was cleared.
- An editor whose composer moved or became ambiguous could keep a stale
  overlay and Tab listener. Read-only and voice modes now remove it too.
- Helpers left behind by a server crash are cleaned up on startup, and an
  interaction raised before `spawn()` returned now stops the helper.
- Unicode line and paragraph separators no longer pass the single-line check.

## 0.1.0 - 2026-10-16

### Added

- Next-message predictions shown as ghost text in an empty thread composer.
- **Tab** inserts the suggestion as an editable draft. Typing, pasting or IME
  input dismisses it. Nothing is ever sent.
- Hidden, archived helper threads that use the conversation's provider and
  model.
- A bounded conversation reconstruction that includes completed tool records.
- Explicit regeneration and dismissal.
