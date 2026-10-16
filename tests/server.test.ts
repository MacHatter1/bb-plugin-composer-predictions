import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { ModelSettings, PredictionState } from "../contract.ts";

const source = makeThreadResponse({ id: "source", providerId: "codex", environmentId: "environment" });
const worker = makeThreadResponse({ id: "worker", visibility: "hidden", title: "Composer prediction helper", originPluginId: "composer-predictions" });
function fixture(options: { pendingInteraction?: boolean; abandoned?: boolean } = {}) {
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
      archive: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    },
    providers: { models: async () => ({ providers: [{ id: "codex", capabilities: { permissionModes: ["auto"] } }], models: [{ id: "model", model: "model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }) },
    system: { executionOptions: async () => ({ providers: [{ id: "codex", available: true }], models: [{ model: "model", routeProviderId: "codex", defaultReasoningEffort: "low", isDefault: true }] }) },
  } });
  return host;
}
async function untilSettled(harness: ReturnType<typeof fixture>["harness"]) {
  for (let count = 0; count < 50; count++) {
    const state = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
    if (state.status !== "generating") return state;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("prediction did not settle");
}
test("server completes a prediction, keeps the source untouched, and cleans up its helper", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const initial = await harness.behavior.callRpc("ensure", { threadId: "source" }) as PredictionState;
    assert.ok(initial.generationId);
    const ready = await untilSettled(harness);
    assert.equal(ready.status, "ready"); assert.equal(ready.suggestion, "Show me the diff");
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.archive"), [[{ threadId: "worker" }]]);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.stop"), [[{ threadId: "worker" }]]);
    assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
  } finally { await harness.lifecycle.dispose(); }
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
  const { bb, harness } = fixture({ abandoned: true });
  try {
    await plugin(bb);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.archive"), [[{ threadId: "worker" }]]);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.stop"), [[{ threadId: "worker" }]]);
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
