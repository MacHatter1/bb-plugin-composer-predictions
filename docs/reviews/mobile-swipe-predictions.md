# Mobile swipe and prediction verification

Base: upstream `main`, `1edfe95a6d2dc92ef2b825938061d8d3ec806399` (v0.4.3).

## Implemented behavior

A deliberate single-finger right swipe inside the empty editor inserts the
visible suggestion through the same composer API as Tab. It never submits.
Touchscreens show a swipe hint. Release must occur within one second, at least
48 CSS pixels to the right, with at most 24 pixels of vertical drift. Screen
edges, vertical/leftward gestures, multi-touch (including a second finger
outside the editor), long holds, context menus, cancellation, editing and a
changed suggestion do not accept. Listeners are removed when the editor or
plugin is disposed. Desktop Tab behavior remains intact.

The prompt distinguishes work the assistant already owns from useful user
actions. It prefers abstention for ongoing or completed work, while retaining
pending approvals, grounded clarifications, known preferences and acceptance
of concrete recommendations the user requested.

## Verification

- 62 unit and BB SDK integration tests passed, including gesture cancellation
  and insertion through the public composer API without submission.
- TypeScript check and plugin build passed.
- Chrome at a 390 × 844 touch viewport: right swipe inserted once with zero
  submissions; short, left, vertical, diagonal and multi-touch gestures did
  not accept. Vertical scrolling moved the page. Desktop Tab also inserted
  without submitting. Screenshots were inspected before and after insertion.
- Browser checks used the real compiled ghost decoration in an isolated
  composer-markup fixture. BB composer insertion was verified separately in
  its SDK harness. This is not a live BB installation test.
- Physical-phone and Safari checks have not been performed.

## Prompt comparison

Both prompt versions used `gpt-6.1-sol`, `low` effort, through independent
Responses requests with no tools. The baseline came from the upstream commit
above. The final candidate is in `lib/prediction.ts`.

| Set | Trials per prompt | Baseline passes | Candidate passes |
| --- | ---: | ---: | ---: |
| Public synthetic fixtures, two repetitions | 32 | 14 | 32 |
| Private historical snapshots, one repetition | 6 | 2 | 6 |
| Total | 38 | 16 | 38 |

Across the 24 trials labelled for abstention, unwanted suggestions went from
22 to 0. Both prompts retained
all 14 positive trials. Suggestions were manually inspected
in addition to the coarse abstention/topic checks. Public inputs live in
`tests/fixtures/prediction-eval.json`; raw public outputs, including a transport
timeout followed by a successful resume, are in
[mobile-swipe-prediction-results.json](mobile-swipe-prediction-results.json).
Private transcripts, identities and outputs are deliberately not included.

Examples from the public fixture: after the agent says tests are running,
the baseline asks for results and the candidate abstains. After a concrete
cookie fix is offered for approval, the candidate proposes applying that fix.

An initial stricter draft suppressed useful recommendations and one historical
clarification. The final wording restores those cases. One overly narrow
topic regex was widened to accept equivalent “update the cookie” wording;
expected suggest/abstain labels stayed unchanged. These are regression cases
used during refinement, not a held-out estimate of real-world acceptance.
The direct-inference harness does not reproduce provider CLI or BB system
instructions. Results are specific to this model, effort and small sample.

See [evaluation instructions](../prediction-evaluation.md) to reproduce the
public comparison or supply private labelled snapshots.
