# Prediction prompt evaluation

`scripts/eval-predictions.ts` compares the prompt at an explicit baseline Git
revision with the current `generationPrompt`. It sends each conversation to
each prompt independently, using the same model and reasoning effort, and
alternates prompt order between repetitions. The model never sees the expected
label or the other prompt's answer. This is an optional paid evaluation, not
part of `npm test`.

## Run

Use an OpenAI-compatible Responses endpoint that supports streaming and the
selected model. Set `PREDICTION_EVAL_BASE_URL` (including `/v1`) and
`PREDICTION_EVAL_API_KEY` securely in the environment. Do not commit credentials
or put them in command arguments.

```sh
node --import tsx scripts/eval-predictions.ts \
  --baseline 1edfe95 \
  --model <available-model> \
  --effort low \
  --repeats 2 \
  --output /tmp/prediction-eval.json
```

The baseline must contain plain template literals for `PREDICTION_PROMPT` and
`WORKER_INSTRUCTIONS`, using the same conversation wrapper. The script refuses
interpolated or escaped literals rather than silently comparing a different
prompt. Results include the resolved baseline SHA, prompt and case hashes,
model, effort, repetitions, suggestions and individual coarse verdicts. They
are saved after every request. A failed request records an error and stops;
transport failures do not count as abstentions or quality results.
After restoring connectivity, repeat the same command with `--resume`. It
checks the model, effort, hashes (including worker instructions and the
conversation wrapper) and repetition count before skipping completed
requests. Failed attempts remain in the report with `error`; exclude those
rows from quality scores. Resume does not change prompts or silently retry a
different model.

## Cases and scoring

The public fixture has 16 synthetic conversations, labelled before running:
10 should abstain and six should suggest a useful next action. They cover
promised/running/completed work, unknown facts and preferences, explicit
waiting, pending approval, known preferences, ambiguous results and staged
next steps. Some scenarios were motivated by observed redundant suggestions;
the public fixture contains no private conversation history.

Abstention cases pass only on `null`. Suggestion cases require a non-null
message and, where supplied, a case-insensitive topic pattern. These checks
measure abstention and topicality, not full semantic quality. Read every
suggestion before concluding that the prompt improved. In particular, check
for invented user preferences, repeated work and loss of useful suggestions.
Keep the original labels when inspecting results; do not change them to make
a run pass.

Use `--cases /path/to/cases.json` to replay private historical conversations.
Each case has `id`, `conversation`, `expected` (`abstain` or `suggest`), and an
optional `match` regex. Preserve the original reconstructed conversation for
a faithful prompt comparison. Keep that file and outputs out of public PRs.

## Limits

This evaluates the plugin's prediction instructions and conversation wrapper
through direct, tool-free inference. It does not reproduce a provider CLI's
default system prompt, BB's environment instructions, helper lifecycle or UI.
The production helper may receive those additional instructions. Results are
specific to the model, effort, fixture and samples used; they are not an
estimate of acceptance rate in normal use. Model output is nondeterministic,
so keep useful positive cases as well as redundant-work regressions.
