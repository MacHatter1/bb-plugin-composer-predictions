import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { ModelSettings, PredictionState } from "../contract.ts";

const source = makeThreadResponse({ id: "source", providerId: "codex", environmentId: "environment" });
const worker = makeThreadResponse({ id: "worker", visibility: "hidden", title: "Composer prediction helper", originPluginId: "composer-predictions" });
function fixture(options: { pendingInteraction?: boolean; abandoned?: boolean } = {}) {
  const operations: string[] = [];
  const host = createFakePluginHost({ pluginId: "composer-predictions", sdk: {
    threads: {
      get: async ({ threadId }) => threadId === "source" ? source : worker,
      list: async () => options.abandoned ? [worker, { ...worker, id: "unmarked" }, { ...worker, id: "visible", visibility: "visible" }, { ...worker, id: "foreign", originPluginId: "other" }] : [],
      getPluginMetadata: async ({ threadId }) => ({ predictionWorker: threadId === "worker" }),
      defaultExecutionOptions: async () => ({ model: "model", reasoningLevel: "low" }),
      events: { list: async () => [
        { seq: 1, type: "client/turn/requested", data: { input: "Fix validation" } },
        { seq: 2, type: "item/completed", data: { item: { type: "agentMessage", text: "Validation fixed" } } },
      ] },
      spawn: async () => worker,
      output: async () => ({ output: '{"suggestion":"Show me the diff"}' }),
      interactions: { list: async () => options.pendingInteraction ? [{ id: "permission" }] : [] },
      archive: async ({ threadId }) => { operations.push(`archive:${threadId}`); return { ok: true }; },
      stop: async ({ threadId }) => { operations.push(`stop:${threadId}`); return { ok: true }; },
    },
    providers: { models: async () => ({ providers: [{ id: "codex", capabilities: { permissionModes: ["auto"] } }], models: [{ id: "model", model: "model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }) },
    system: { executionOptions: async () => ({ providers: [{ id: "codex", available: true }], models: [{ model: "model", routeProviderId: "codex", defaultReasoningEffort: "low", isDefault: true }] }) },
  } });
  return { ...host, operations };
}
async function untilSettled(harness: ReturnType<typeof fixture>["harness"]) {
  for (let count = 0; count < 50; count++) {
    const state = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
    if (state.status !== "generating") return state;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("prediction did not settle");
}
async function untilReleased(harness: ReturnType<typeof fixture>["harness"], threadId = "worker") {
  for (let count = 0; count < 50; count++) {
    if (harness.inspection.sdk.callsTo("threads.archive").some(([args]) => (args as { threadId?: string }).threadId === threadId)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`helper ${threadId} was not archived`);
}
test("server completes a prediction, keeps the source untouched, and cleans up its helper", async () => {
  const { bb, harness, operations } = fixture();
  try {
    await plugin(bb);
    const initial = await harness.behavior.callRpc("ensure", { threadId: "source" }) as PredictionState;
    assert.ok(initial.generationId);
    const ready = await untilSettled(harness);
    assert.equal(ready.status, "ready"); assert.equal(ready.suggestion, "Show me the diff");
    await untilReleased(harness);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    assert.equal((harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { permissionMode?: string }).permissionMode, "auto");
    assert.deepEqual(operations, ["stop:worker", "archive:worker"]);
    assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test("a helper is stopped and archived as soon as its thread moves on", async () => {
  const { bb, harness, operations } = fixture();
  const running = { ...worker, status: "active" as const };
  harness.sdk.stub("threads.get", async ({ threadId }) => threadId === "source" ? source : running);
  try {
    await plugin(bb);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    for (let count = 0; count < 50 && harness.inspection.sdk.callsTo("threads.spawn").length === 0; count++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    await harness.behavior.emitThreadEvent("thread.active", { thread: { ...source, status: "active" } });
    await untilReleased(harness);
    assert.deepEqual(operations, ["stop:worker", "archive:worker"]);
    const state = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
    assert.equal(state.status, "idle"); assert.equal(state.suggestion, null);
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test("provider archive latency does not delay the suggestion", async () => {
  const { bb, harness } = fixture();
  let openGate: () => void = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  let archived = false;
  harness.sdk.stub("threads.archive", async () => { await gate; archived = true; return { ok: true }; });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    const ready = await untilSettled(harness);
    assert.equal(ready.status, "ready"); assert.equal(ready.suggestion, "Show me the diff");
    assert.equal(archived, false);
    openGate();
    for (let count = 0; count < 50 && !archived; count++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(archived, true);
  } finally { await harness.lifecycle.dispose(); }
});
test("a failed archive is logged, the suggestion still appears, and disposal retries it", async () => {
  const { bb, harness } = fixture();
  let attempts = 0;
  harness.sdk.stub("threads.archive", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("archive unavailable");
    return { ok: true };
  });
  let disposed = false;
  try {
    await plugin(bb);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).suggestion, "Show me the diff");
    for (let count = 0; count < 50 && !warned(harness, "archive unavailable"); count++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(warned(harness, "archive unavailable"));
    assert.equal(attempts, 1);
    await harness.lifecycle.dispose();
    disposed = true;
    assert.equal(attempts, 2);
  } finally { if (!disposed) await harness.lifecycle.dispose(); }
});
test("a permission interaction created before spawn returns still cancels and cleans up the helper", async () => {
  const { bb, harness } = fixture({ pendingInteraction: true });
  try {
    await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).status, "error");
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.stop"), [[{ threadId: "worker" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
test("startup recovers only this plugin's marked hidden helper threads", async () => {
  const { bb, harness, operations } = fixture({ abandoned: true });
  try {
    await plugin(bb);
    assert.deepEqual(operations, ["stop:worker", "archive:worker"]);
  } finally { await harness.lifecycle.dispose(); }
});
test("startup archives finished pre-existing helpers and leaves the current thread and in-use helpers alone", async () => {
  const { bb, harness, operations } = fixture();
  const current = { ...source, id: "current", title: "Add auto-archiving", visibility: "visible" as const };
  const finished = { ...worker, id: "finished", status: "idle" as const };
  const failed = { ...worker, id: "failed", status: "error" as const };
  const busy = { ...worker, id: "busy", status: "active" as const };
  const starting = { ...worker, id: "starting-helper", status: "starting" as const };
  const pending = { ...worker, id: "pending-helper", status: "pending" as const };
  harness.sdk.stub("threads.list", async () => [
    current, finished, failed, busy, starting, pending,
    { ...worker, id: "unmarked" },
    { ...finished, id: "already", archivedAt: 1 },
    { ...worker, id: "shown-busy", status: "active", visibility: "visible" },
    { ...finished, id: "shown", visibility: "visible" },
  ]);
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }) => ({ predictionWorker: threadId !== "unmarked" }));
  harness.sdk.stub("threads.update", async () => worker);
  try {
    await plugin(bb);
    assert.deepEqual(operations, ["stop:finished", "archive:finished", "stop:failed", "archive:failed", "stop:shown", "archive:shown"]);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.update"), [[{ threadId: "shown", visibility: "hidden" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
const warned = (harness: ReturnType<typeof fixture>["harness"], text: string) =>
  harness.inspection.logEntries.some(entry => entry.level === "warn" && entry.message.includes(text));
test("the plugin still loads and predicts when startup recovery cannot list threads", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("threads.list", async () => { throw new Error("threads unavailable"); });
  try {
    await plugin(bb);
    assert.ok(warned(harness, "threads unavailable"));
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).status, "ready");
  } finally { await harness.lifecycle.dispose(); }
});
test("one unreadable helper does not stop startup recovering the others", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("threads.list", async () => [worker, { ...worker, id: "worker-2" }]);
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }) => {
    if (threadId === "worker") throw new Error("metadata unavailable");
    return { predictionWorker: true };
  });
  try {
    await plugin(bb);
    assert.ok(warned(harness, "metadata unavailable"));
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.archive"), [[{ threadId: "worker-2" }]]);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.stop"), [[{ threadId: "worker-2" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
test("a helper that cannot be stopped after asking for input is logged, not thrown, and still fails closed", async () => {
  const { bb, harness } = fixture();
  const running = { ...worker, status: "active" as const };
  harness.sdk.stub("threads.get", async ({ threadId }) => threadId === "source" ? source : running);
  harness.sdk.stub("threads.stop", async () => { throw new Error("already stopped"); });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    // Wait until the generation is polling its running helper.
    const polling = () => harness.inspection.sdk.callsTo("threads.get").some(([args]) => (args as { threadId: string }).threadId === "worker");
    for (let count = 0; count < 50 && !polling(); count++) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const { errors } = await harness.behavior.emitThreadEvent("interaction.pending", { thread: running, interaction: { id: "permission" } as never });
    assert.deepEqual(errors, []);
    assert.ok(warned(harness, "already stopped"));
    assert.equal((await untilSettled(harness)).status, "error");
    await untilReleased(harness);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.archive"), [[{ threadId: "worker" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
test("ordinary threads get the bundled skill; marked helpers get no skills, only worker instructions", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const configure = harness.inspection.registrations.agentConfigurationProvider!;
    // BB rejects the whole selection for an unknown name, so keep it tied to the skill's frontmatter.
    const skill = (await readFile(new URL("../skills/composer-predictions/SKILL.md", import.meta.url), "utf8")).match(/^name: (.+)$/m)?.[1];
    const context = (title: string, pluginMetadata: Record<string, boolean>) => ({ thread: { title }, pluginMetadata }) as unknown as Parameters<typeof configure>[0];
    assert.deepEqual(configure(context("Fix validation", {})), { tools: [], skills: [skill] });
    assert.deepEqual(configure(context("Composer prediction helper", {})), { tools: [], skills: [skill] });
    const helper = configure(context("Composer prediction helper", { predictionWorker: true }));
    assert.deepEqual(helper.tools, []); assert.deepEqual(helper.skills, []); assert.ok(helper.instructions?.includes("Do not call tools"));
  } finally { await harness.lifecycle.dispose(); }
});

const customModel = { providerId: "other", model: "prediction-model", reasoningLevel: "medium", serviceTier: "fast" };
const customCatalog = { providers: [{ id: "other", capabilities: { permissionModes: ["auto"] } }], models: [{ id: "prediction-alias", model: "prediction-model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }], supportedServiceTiers: [{ id: "fast", label: "Fast" }] }] };
test("separate prediction model persists across reload, routes through the source environment, and resets", async () => {
  const { bb, harness } = fixture();
  let currentHarness = harness;
  try {
    await plugin(bb);
    const initial = await harness.behavior.callRpc("model_get", {}) as ModelSettings;
    assert.equal(initial.selection, null); assert.equal(initial.pickerDefault?.model, "model");
    harness.sdk.stub("providers.models", async () => customCatalog);
    const saved = await harness.behavior.callRpc("model_set", { ...customModel, model: "prediction-alias" }) as ModelSettings;
    assert.deepEqual(saved.selection, { ...customModel, reasoningLevel: "low" });
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).model, "prediction-model");
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
    assert.equal(spawn.providerId, "other"); assert.equal(spawn.model, "prediction-model"); assert.equal(spawn.reasoningLevel, "low"); assert.equal(spawn.serviceTier, "fast");
    assert.deepEqual(spawn.environment, { type: "reuse", environmentId: "environment" });
    assert.equal(harness.inspection.sdk.callsTo("threads.defaultExecutionOptions").length, 0);
    assert.deepEqual(harness.inspection.sdk.callsTo("providers.models").at(-1)![0], { providerId: "other", environmentId: "environment", signal: (harness.inspection.sdk.callsTo("providers.models").at(-1)![0] as { signal: AbortSignal }).signal });
    currentHarness = (await harness.lifecycle.reload(plugin)).harness;
    assert.deepEqual((await currentHarness.behavior.callRpc("model_get", {}) as ModelSettings).selection, saved.selection);
    assert.equal((await currentHarness.behavior.callRpc("model_clear", {}) as ModelSettings).selection, null);
    currentHarness.sdk.stub("providers.models", async () => ({ providers: [{ id: "codex", capabilities: { permissionModes: ["auto"] } }], models: [{ id: "model", model: "model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }));
    await currentHarness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(currentHarness)).model, "model");
  } finally { await currentHarness.lifecycle.dispose(); }
});
const askingCatalog = {
  providers: [{ id: "codex", capabilities: { permissionModes: ["full", "accept-edits"] } }],
  models: [{ id: "model", model: "model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
};
async function untilCalled(harness: ReturnType<typeof fixture>["harness"], path: string) {
  for (let count = 0; count < 50 && harness.inspection.sdk.callsTo(path).length === 0; count++) await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(harness.inspection.sdk.callsTo(path).length, 0, path);
}
test("a provider without automatic approval still predicts, and asks beside the conversation when it needs approval", async () => {
  const { bb, harness } = fixture();
  let interactions: { id: string }[] = [{ id: "permission" }];
  let status: "active" | "idle" = "active";
  harness.sdk.stub("providers.models", async () => askingCatalog);
  harness.sdk.stub("threads.interactions.list", async () => interactions);
  harness.sdk.stub("threads.get", async ({ threadId }) => threadId === "source" ? source : { ...worker, status });
  harness.sdk.stub("threads.update", async () => worker);
  harness.sdk.stub("threads.open", async () => ({ delivered: true }));
  try {
    await plugin(bb);
    const saved = await harness.behavior.callRpc("model_set", { providerId: "codex", model: "model", reasoningLevel: "low" }) as ModelSettings;
    assert.deepEqual(saved.selection, { providerId: "codex", model: "model", reasoningLevel: "low" });
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    await untilCalled(harness, "threads.open");
    assert.equal((harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { permissionMode?: string }).permissionMode, "accept-edits");
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.update")[0], [{ threadId: "worker", visibility: "visible" }]);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.open")[0], [{ threadId: "worker", file: null, split: "right" }]);
    const { errors } = await harness.behavior.emitThreadEvent("interaction.pending", { thread: { ...worker, status: "active" }, interaction: { id: "permission" } as never });
    assert.deepEqual(errors, []);
    assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
    interactions = [];
    status = "idle";
    const deadline = Date.now() + 3000;
    let ready: PredictionState = { threadId: "source", sourceKey: null, generationId: null, status: "generating", suggestion: null, model: null, contextCharacters: 0, updatedAt: 0, error: null };
    while (Date.now() < deadline) {
      await harness.behavior.emitThreadEvent("thread.idle", { thread: { ...worker, status: "idle" }, lastAssistantText: null });
      ready = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
      if (ready.status !== "generating") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready.status, "ready"); assert.equal(ready.suggestion, "Show me the diff");
    await untilReleased(harness);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.update").at(-1), [{ threadId: "worker", visibility: "hidden" }]);
  } finally { await harness.lifecycle.dispose(); }
});
test("moving the conversation on cancels a helper that is waiting for approval", async () => {
  const { bb, harness, operations } = fixture();
  harness.sdk.stub("providers.models", async () => askingCatalog);
  harness.sdk.stub("threads.interactions.list", async () => [{ id: "permission" }]);
  harness.sdk.stub("threads.get", async ({ threadId }) => threadId === "source" ? source : { ...worker, status: "active" });
  harness.sdk.stub("threads.update", async () => worker);
  harness.sdk.stub("threads.open", async () => ({ delivered: true }));
  try {
    await plugin(bb);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    await untilCalled(harness, "threads.open");
    assert.equal((harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { permissionMode?: string }).permissionMode, "accept-edits");
    await harness.behavior.emitThreadEvent("thread.active", { thread: { ...source, status: "active" } });
    await untilReleased(harness);
    assert.deepEqual(operations, ["stop:worker", "archive:worker"]);
    const state = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
    assert.equal(state.status, "idle"); assert.equal(state.suggestion, null);
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test("a provider with only full access cannot be selected for predictions", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("providers.models", async () => ({ ...askingCatalog, providers: [{ id: "codex", capabilities: { permissionModes: ["full"] } }] }));
  try {
    await plugin(bb);
    await assert.rejects(() => harness.behavior.callRpc("model_set", { providerId: "codex", model: "model", reasoningLevel: "low" }), /ask you for approval/);
    assert.equal((await harness.behavior.callRpc("model_get", {}) as ModelSettings).selection, null);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).status, "error");
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test("invalid or unavailable prediction models cannot silently switch to another model", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    await assert.rejects(() => harness.behavior.callRpc("model_set", { ...customModel, model: "missing" }));
    assert.equal((await harness.behavior.callRpc("model_get", {}) as ModelSettings).selection, null);
    harness.sdk.stub("providers.models", async (args: { environmentId?: string }) => args.environmentId ? { ...customCatalog, models: [] } : customCatalog);
    await harness.behavior.callRpc("model_set", customModel);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).status, "error");
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal((await harness.behavior.callRpc("model_get", {}) as ModelSettings).selection?.model, "prediction-model");
  } finally { await harness.lifecycle.dispose(); }
});
test("the picker preserves provider-specific reasoning and service tier names", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    harness.sdk.stub("providers.models", async () => ({ ...customCatalog, models: [{ ...customCatalog.models[0], defaultReasoningEffort: "adaptive", supportedReasoningEfforts: [{ reasoningEffort: "adaptive" }], supportedServiceTiers: [{ id: "priority", label: "Priority" }] }] }));
    const selection = { ...customModel, reasoningLevel: "adaptive", serviceTier: "priority" };
    assert.deepEqual((await harness.behavior.callRpc("model_set", selection) as ModelSettings).selection, selection);
    await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness);
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
    assert.equal(spawn.reasoningLevel, "adaptive"); assert.equal(spawn.serviceTier, "priority");
  } finally { await harness.lifecycle.dispose(); }
});

for (const status of ["ready", "abstained", "dismissed"] as const) {
  test(`${status} predictions survive plugin reload without another model request`, async () => {
    const { bb, harness } = fixture();
    let current = harness;
    try {
      if (status === "abstained") harness.sdk.stub("threads.output", async () => ({ output: '{"suggestion":null}' }));
      await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" });
      let before = await untilSettled(harness);
      if (status === "dismissed") before = await harness.behavior.callRpc("dismiss", { threadId: "source", generationId: before.generationId }) as PredictionState;
      current = (await harness.lifecycle.reload(plugin)).harness;
      const spawns = current.inspection.sdk.callsTo("threads.spawn").length;
      assert.equal((await current.behavior.callRpc("get", { threadId: "source" }) as PredictionState).suggestion, null, "persisted text must not be shown before validation");
      await current.behavior.callRpc("ensure", { threadId: "source" });
      const after = await untilSettled(current);
      assert.equal(after.status, status); assert.equal(after.generationId, before.generationId);
      assert.equal(after.suggestion, before.suggestion); assert.equal(after.sourceKey, before.sourceKey);
      assert.equal(current.inspection.sdk.callsTo("threads.spawn").length, spawns);
    } finally { await current.lifecycle.dispose(); }
  });
}
test("thread movement while offline invalidates a persisted prediction even when quoted text is identical", async () => {
  const { bb, harness } = fixture();
  let current = harness;
  try {
    await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" });
    const before = await untilSettled(harness);
    current = (await harness.lifecycle.reload(plugin)).harness;
    current.sdk.stub("threads.events.list", async () => [
      { seq: 21, type: "client/turn/requested", data: { input: "Fix validation" } },
      { seq: 22, type: "item/completed", data: { item: { type: "agentMessage", text: "Validation fixed" } } },
    ]);
    const spawns = current.inspection.sdk.callsTo("threads.spawn").length;
    await current.behavior.callRpc("ensure", { threadId: "source" }); const after = await untilSettled(current);
    assert.equal(after.status, "ready"); assert.notEqual(after.sourceKey, before.sourceKey);
    assert.notEqual(after.generationId, before.generationId);
    assert.equal(current.inspection.sdk.callsTo("threads.spawn").length, spawns + 1);
  } finally { await current.lifecycle.dispose(); }
});
test("source model changes while offline invalidate a persisted prediction", async () => {
  const { bb, harness } = fixture();
  let current = harness;
  try {
    await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" });
    const before = await untilSettled(harness);
    current = (await harness.lifecycle.reload(plugin)).harness;
    current.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "new-model", reasoningLevel: "low" }));
    current.sdk.stub("providers.models", async () => ({ providers: [{ id: "codex", capabilities: { permissionModes: ["auto"] } }], models: [{ id: "new-model", model: "new-model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }));
    const spawns = current.inspection.sdk.callsTo("threads.spawn").length;
    await current.behavior.callRpc("ensure", { threadId: "source" }); const after = await untilSettled(current);
    assert.equal(after.model, "new-model"); assert.notEqual(after.sourceKey, before.sourceKey);
    assert.equal(current.inspection.sdk.callsTo("threads.spawn").length, spawns + 1);
  } finally { await current.lifecycle.dispose(); }
});
test("failed generations are not persisted and a reload permits another attempt", async () => {
  const { bb, harness } = fixture();
  let current = harness;
  try {
    harness.sdk.stub("threads.output", async () => ({ output: "invalid" }));
    await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).status, "error");
    current = (await harness.lifecycle.reload(plugin)).harness;
    current.sdk.stub("threads.output", async () => ({ output: '{"suggestion":"Try again"}' }));
    const spawns = current.inspection.sdk.callsTo("threads.spawn").length;
    await current.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(current)).suggestion, "Try again");
    assert.equal(current.inspection.sdk.callsTo("threads.spawn").length, spawns + 1);
  } finally { await current.lifecycle.dispose(); }
});
test("settings invalidate dormant persisted entries and explicit regeneration bypasses disk cache", async () => {
  const { bb, harness } = fixture();
  let current = harness;
  try {
    await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" });
    const before = await untilSettled(harness);
    current = (await harness.lifecycle.reload(plugin)).harness;
    await current.behavior.setSettings({ contextCharacters: 4000 });
    await current.behavior.callRpc("ensure", { threadId: "source" }); const changed = await untilSettled(current);
    assert.notEqual(changed.generationId, before.generationId);
    await current.behavior.callRpc("regenerate", { threadId: "source" }); const forced = await untilSettled(current);
    assert.notEqual(forced.generationId, changed.generationId);
  } finally { await current.lifecycle.dispose(); }
});
test("a thread archived while the plugin was offline cannot restore a saved suggestion", async () => {
  const { bb, harness } = fixture();
  let current = harness;
  try {
    await plugin(bb); await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness);
    current = (await harness.lifecycle.reload(plugin)).harness;
    current.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "source" ? { ...source, archivedAt: 1 } : worker);
    const spawns = current.inspection.sdk.callsTo("threads.spawn").length;
    await current.behavior.callRpc("ensure", { threadId: "source" });
    const state = await untilSettled(current);
    assert.equal(state.status, "idle"); assert.equal(state.suggestion, null);
    assert.equal(current.inspection.sdk.callsTo("threads.spawn").length, spawns);
  } finally { await current.lifecycle.dispose(); }
});
