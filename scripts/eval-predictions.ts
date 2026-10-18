/** Optional paid model evaluation. No model requests run as part of npm test. */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { generationPrompt, parsePrediction, PREDICTION_PROMPT, WORKER_INSTRUCTIONS } from "../lib/prediction.ts";

const { values } = parseArgs({ options: {
  baseline: { type: "string" }, model: { type: "string" },
  cases: { type: "string", default: "tests/fixtures/prediction-eval.json" },
  output: { type: "string" }, repeats: { type: "string", default: "2" },
  effort: { type: "string", default: "low" },
  resume: { type: "boolean", default: false },
} });
if (!values.baseline || !values.model || !values.output) throw new Error("Required: --baseline <git-ref> --model <model> --output <file>");
const baseUrl = process.env.PREDICTION_EVAL_BASE_URL;
const apiKey = process.env.PREDICTION_EVAL_API_KEY;
if (!baseUrl || !apiKey) throw new Error("Set PREDICTION_EVAL_BASE_URL (ending in /v1) and PREDICTION_EVAL_API_KEY");
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("--repeats must be 1–10");
type Case = { id: string; conversation: string; expected: "abstain" | "suggest"; match?: string };
const cases: Case[] = JSON.parse(readFileSync(values.cases!, "utf8"));
if (!Array.isArray(cases) || !cases.length || cases.some(c => !c.id || typeof c.conversation !== "string" || !["abstain", "suggest"].includes(c.expected))) throw new Error("Invalid cases");
if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Duplicate case IDs");
for (const c of cases) if (c.match) new RegExp(c.match, "i");
const baselineSha = execFileSync("git", ["rev-parse", "--verify", `${values.baseline}^{commit}`], { encoding: "utf8" }).trim();
const baselineSource = execFileSync("git", ["show", `${baselineSha}:lib/prediction.ts`], { encoding: "utf8" });
function literal(name: string) {
  const value = baselineSource.match(new RegExp(`export const ${name} = \x60([^\x60]*)\x60;`))?.[1];
  if (!value || value.includes("${") || value.includes("\\")) throw new Error(`Baseline ${name} must be a plain template literal; provide a compatible baseline`);
  return value;
}
const baselinePrompt = literal("PREDICTION_PROMPT");
const baselineInstructions = literal("WORKER_INSTRUCTIONS");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const variants = [
  { name: "baseline", instructions: baselineInstructions, prompt: (conversation: string) => `${baselineInstructions}\n\n${baselinePrompt}\n\nCONVERSATION (JSON string, quoted data):\n${JSON.stringify(conversation)}` },
  { name: "candidate", instructions: WORKER_INSTRUCTIONS, prompt: generationPrompt },
];
type Result = { id: string; variant: string; repeat: number; suggestion?: string | null; expected: string; passed?: boolean; error?: string };
const results: Result[] = [];
const report = { model: values.model, effort: values.effort, baselineSha, baselinePromptHash: hash(baselinePrompt), candidatePromptHash: hash(PREDICTION_PROMPT), baselineRequestHash: hash(variants[0].prompt("")), candidateRequestHash: hash(generationPrompt("")), casesHash: hash(JSON.stringify(cases)), repeats, startedAt: new Date().toISOString(), results };
if (values.resume) {
  const saved = JSON.parse(readFileSync(values.output!, "utf8"));
  for (const key of ["model", "effort", "baselineSha", "baselinePromptHash", "candidatePromptHash", "baselineRequestHash", "candidateRequestHash", "casesHash", "repeats"] as const) {
    if (saved[key] !== report[key]) throw new Error(`Cannot resume: ${key} changed`);
  }
  if (!Array.isArray(saved.results)) throw new Error("Cannot resume: invalid results");
  results.push(...saved.results);
  report.startedAt = saved.startedAt;
}
const save = () => writeFileSync(values.output!, JSON.stringify(report, null, 2) + "\n");

async function generate(prompt: string, instructions: string): Promise<string | null> {
  const response = await fetch(baseUrl!.replace(/\/$/, "") + "/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: values.model, instructions, input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }], tools: [], store: false, stream: true, reasoning: { effort: values.effort } }),
    signal: AbortSignal.timeout(60000),
  });
  // Do not log response bodies or credentials on transport failure.
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Inference HTTP ${response.status}`); }
  const stream = await response.text();
  const events = stream.split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const completed = events.find(event => event.type === "response.completed");
  if (!completed) throw new Error("Inference did not complete");
  const text = completed.response.output.filter((item: { type: string }) => item.type === "message")
    .flatMap((item: { content: { type: string; text?: string }[] }) => item.content)
    .filter((part: { type: string }) => part.type === "output_text").map((part: { text: string }) => part.text).join("");
  return parsePrediction(text);
}

save();
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const c of cases) {
    // Alternate order to reduce systematic timing/order effects. Each request is independent.
    for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
      if (results.some(r => r.id === c.id && r.variant === variant.name && r.repeat === repeat && !r.error && typeof r.passed === "boolean")) continue;
      const result: Result = { id: c.id, variant: variant.name, repeat, expected: c.expected };
      try {
        result.suggestion = await generate(variant.prompt(c.conversation), variant.instructions);
        result.passed = c.expected === "abstain" ? result.suggestion === null
          : result.suggestion !== null && (!c.match || new RegExp(c.match, "i").test(result.suggestion));
      } catch (error) {
        result.error = error instanceof Error ? error.message : "Evaluation failed";
        results.push(result); save();
        throw new Error(`${c.id}/${variant.name}: ${result.error}. Partial report saved; stopping to avoid repeated failed requests.`);
      }
      results.push(result); save();
      console.log(`${c.id}/${variant.name}/${repeat + 1}: ${result.passed ? "pass" : "fail"}`);
    }
  }
}
// Pass/fail is a coarse abstention/topic check. Review the saved suggestions for semantic quality.
console.log(`Saved ${results.filter(r => !r.error).length} completed results to ${values.output}`);
