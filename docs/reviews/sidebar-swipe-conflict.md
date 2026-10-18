# Composer padding and sidebar swipe conflict

A right swipe starting in BB's padded composer text area could open the sidebar
instead of accepting a prediction. The original gesture listener covered only
the contenteditable element. BB excludes that element from sidebar gestures,
but its surrounding padding was still eligible.

The decoration now listens on `data-promptbox-editor-scroll` (falling back to the
editor parent). While a suggestion is visible it sets BB's existing
`data-no-sidebar-swipe` exclusion before document-capture pointer/touch listeners
run. It restores the previous attribute on hide, acceptance, dismissal and
disposal. Nested controls cannot accept predictions.

The reserved region uses `touch-action: pan-y pinch-zoom` so horizontal gestures
do not become browser navigation, while vertical scrolling and zoom remain
available. Browsers may deliver non-cancelable horizontal touchmoves under this
rule; those still track toward release. Existing distance, direction, duration,
multitouch, generation and input cancellation rules remain in place.

## Verification

- 66 unit tests pass, including padded-area gestures, document-capture sidebar
  exclusions for touch and pointer starts, cleanup, controls and non-cancelable
  horizontal moves. Typecheck and plugin build pass.
- Chrome touch emulation at 390 × 844 against the running BB server, with an
  isolated test composer inserted inside the real sidebar inset:
  - Before: a swipe starting at x=61 in text-area padding opened the real sidebar
    and accepted nothing.
  - After: the same swipe accepted one draft, submitted nothing, and kept the
    real sidebar closed.
  - A vertical swipe scrolled the test container without accepting a draft.
  - An edge-zone swipe outside the composer still opened the real sidebar.
- The test composer uses the real decoration and a stub draft insertion callback;
  it does not send messages or alter a user's draft.
- The user confirmed on a physical iPad that swiping right from the composer
  padding accepts the suggestion, and approved this fix for upstream submission.
  The browser and OS versions were not recorded.
- Wider-content browser navigation behavior outside the reserved composer area
  is controlled by BB and the browser, not this patch.
