import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConversation, parsePrediction, sourceKey } from "../lib/prediction.ts";
import { PredictionCoordinator, type Source } from "../lib/coordinator.ts";

test("context includes user, assistant, tool arguments and results in order; excludes reasoning and binary", () => {
  const context = buildConversation([
    { seq: 4, type: "item/completed", data: { item: { type: "agentMessage", text: "The issue is fixed." } } },
    { seq: 1, type: "client/turn/requested", data: { input: [{ type: "text", text: "Fix the validation bug" }] } },
    { seq: 3, type: "item/completed", data: { item: { type: "commandExecution", command: "npm test", aggregatedOutput: "3 tests passed", encryptedContent: "secretblob" } } },
    { seq: 2, type: "item/completed", data: { item: { type: "reasoning", text: "private reasoning" } } },
  ], 48000);
  assert.ok(context.indexOf("Fix the validation bug") < context.indexOf("npm test"));
  assert.ok(context.indexOf("3 tests passed") < context.indexOf("The issue is fixed"));
  assert.ok(!context.includes("private reasoning")); assert.ok(!context.includes("secretblob"));
});
test("context is bounded with both early intent and latest answer retained", () => {
  const context = buildConversation([
    { seq: 1, type: "client/turn/requested", data: { input: "EARLY INTENT " + "x".repeat(40000) } },
    { seq: 2, type: "item/completed", data: { item: { type: "agentMessage", text: "y".repeat(40000) + " LATEST ANSWER" } } },
  ], 4000);
  assert.equal(context.length, 4000); assert.ok(context.includes("EARLY INTENT")); assert.ok(context.includes("LATEST ANSWER"));
  assert.equal(buildConversation([], 4000), "");
});
test("prediction parser enforces one short message or abstention", () => {
  assert.equal(parsePrediction('{"suggestion":"Show me the diff"}'), "Show me the diff");
  assert.equal(parsePrediction('```json\n{"suggestion":null}\n```'), null);
  for (const output of ['hello', '{}', '{"suggestion":3}', '{"suggestion":""}', JSON.stringify({ suggestion: "x".repeat(241) }), JSON.stringify({ suggestion: "one\ntwo" }), '{"suggestion":"ok","extra":true}']) assert.throws(() => parsePrediction(output));
  assert.notEqual(sourceKey("one", "hello"), sourceKey("two", "hello"));
});
test("an unanswered or interrupted user message does not generate a prediction", () => {
  assert.equal(buildConversation([
    { seq: 1, type: "item/completed", data: { item: { type: "agentMessage", text: "Previous answer" } } },
    { seq: 2, type: "client/turn/requested", data: { input: "An unanswered request" } },
  ], 4000), "");
});
const snapshot: Source = { key: "first", model: "test", conversation: "context" };
test("coordinator deduplicates repeated requests, dismissal survives, stale dismissal cannot clear a new answer", async () => {
  let generations = 0; let source = snapshot;
  const engine = new PredictionCoordinator({ source: async () => source, generate: async () => { generations++; return "Show the diff"; }, changed() {}, log: assert.fail });
  engine.request("a"); engine.request("a"); await engine.settled("a");
  assert.equal(generations, 1); assert.equal(engine.get("a").status, "ready");
  const firstGeneration = engine.get("a").generationId;
  engine.dismiss("a", firstGeneration); engine.request("a"); await engine.settled("a");
  assert.equal(generations, 1); assert.equal(engine.get("a").status, "dismissed");
  source = { ...snapshot, key: "second" }; engine.request("a"); await engine.settled("a");
  engine.dismiss("a", firstGeneration); assert.equal(engine.get("a").status, "ready");
  await engine.dispose();
});
test("cancellation discards late model results and concurrency is bounded", async () => {
  let running = 0; let max = 0;
  const releases: (() => void)[] = [];
  const engine = new PredictionCoordinator({
    source: async () => snapshot,
    generate: async (_id, _source, signal) => {
      running++; max = Math.max(max, running);
      await new Promise<void>(resolve => { releases.push(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
      running--; return "late response";
    }, changed() {}, log: assert.fail,
  }, 1);
  engine.request("a"); engine.request("b"); engine.request("c");
  await new Promise(resolve => setTimeout(resolve, 10));
  engine.clear("a");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(engine.get("a").suggestion, null); assert.equal(max, 1);
  releases.forEach(release => release());
  await engine.dispose();
});
test("unload waits for cleanup of a job already cancelled by typing", async () => {
  let release = () => {};
  let started = () => {};
  const active = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const engine = new PredictionCoordinator({ source: async () => snapshot, generate: async () => { started(); await held; return "late"; }, changed() {}, log: assert.fail });
  engine.request("a"); await active; engine.clear("a");
  let disposed = false;
  const stopping = engine.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  release(); await stopping; assert.equal(disposed, true);
});

test("a dismissal for an earlier generation cannot cancel regeneration of the same context", async () => {
  const engine = new PredictionCoordinator({ source: async () => snapshot, generate: async () => "next", changed() {}, log: assert.fail });
  engine.request("a"); await engine.settled("a");
  const first = engine.get("a").generationId;
  engine.clear("a"); engine.request("a", true); await engine.settled("a");
  assert.notEqual(engine.get("a").generationId, first);
  engine.dismiss("a", first);
  assert.equal(engine.get("a").status, "ready");
  await engine.dispose();
});
test("typing while conversation context loads cancels that generation until the next turn", async () => {
  let release = () => {};
  let generations = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const engine = new PredictionCoordinator({ source: async () => { await held; return snapshot; }, generate: async () => { generations++; return "next"; }, changed() {}, log: assert.fail });
  const initial = engine.request("a");
  assert.ok(initial.generationId, "the initial response must identify the pending generation");
  engine.dismiss("a", initial.generationId); release();
  await new Promise(resolve => setImmediate(resolve));
  engine.request("a"); await engine.settled("a");
  assert.equal(generations, 0); assert.equal(engine.get("a").status, "dismissed");
  engine.clear("a"); engine.request("a"); await engine.settled("a"); assert.equal(generations, 1);
  await engine.dispose();
});
test("Unicode line separators are rejected as multiline predictions", () => {
  for (const separator of ["\u0085", "\u2028", "\u2029"]) assert.throws(() => parsePrediction(JSON.stringify({ suggestion: `first${separator}second` })));
});
