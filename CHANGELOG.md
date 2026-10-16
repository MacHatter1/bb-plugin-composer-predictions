# Changelog

All notable changes to Composer Predictions are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- A bundled agent skill for `bb composer-predictions`, offered to ordinary
  threads. Prediction helpers still receive no skills.

### Changed

- Design notes and per-release review records moved to `docs/`.

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
