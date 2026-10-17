# Changelog

All notable changes to Composer Predictions are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

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
