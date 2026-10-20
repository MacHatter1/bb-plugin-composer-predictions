import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { ModelSettings, PredictionState } from "../contract.ts";

const source = makeThreadResponse({ id: "source", providerId: "codex", environmentId: "environment" });
const worker = makeThreadResponse({ id: "worker", visibility: "hidden", title: "Composer prediction helper", originPluginId: "composer-predictions" });
function fixture(options: { pendingInteraction?: boolean; abandoned?: boolean } = {}) {
  const operations: string[] = [];
  const metadata = new Map<string, Record<string, unknown>>();
  let spawned = 0;
  const host = createFakePluginHost({ pluginId: "composer-predictions", sdk: {
    threads: {
      get: async ({ threadId }) => threadId === "source" ? source : { ...worker, id: threadId },
      list: async () => options.abandoned ? [worker, { ...worker, id: "unmarked" }, { ...worker, id: "visible", visibility: "visible" }, { ...worker, id: "foreign", originPluginId: "other" }] : [],
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? { predictionWorker: threadId === "worker" },
      updatePluginMetadata: async ({ threadId, set }) => {
        const next = { ...(metadata.get(threadId) ?? { predictionWorker: threadId === "worker" }), ...set };
        metadata.set(threadId, next);
        return next;
      },
      defaultExecutionOptions: async () => ({ model: "model", reasoningLevel: "low" }),
      events: { list: async () => [
        { seq: 1, type: "client/turn/requested", data: { input: "Fix validation" } },
        { seq: 2, type: "item/completed", data: { item: { type: "agentMessage", text: "Validation fixed" } } },
      ] },
      spawn: async (args) => {
        const id = ++spawned === 1 ? worker.id : `worker-${spawned}`;
        metadata.set(id, args.pluginMetadata ?? {});
        return { ...worker, id };
      },
      output: async () => ({ output: '{"suggestion":"Show me the diff"}' }),
      interactions: { list: async () => options.pendingInteraction ? [{ id: "permission" }] : [] },
      archive: async ({ threadId }) => { operations.push(`archive:${threadId}`); return { ok: true }; },
      stop: async ({ threadId }) => { operations.push(`stop:${threadId}`); return { ok: true }; },
      delete: async ({ threadId }) => { operations.push(`delete:${threadId}`); return { ok: true }; },
    },
    providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { permissionModes: ["auto"] } }],
      models: async () => ({ providers: [{ id: "codex", available: true, capabilities: { permissionModes: ["auto"] } }], models: [{ id: "model", model: "model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }),
    },
  } });
  return { ...host, operations };
}
async function loadPlugin(bb: ReturnType<typeof fixture>["bb"], harness: ReturnType<typeof fixture>["harness"]) {
  await plugin(bb);
  await harness.behavior.runService("helper-cleanup").done;
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
test("a slow recovery does not block plugin loading and aborts on disposal", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("threads.list", async ({ signal }: { signal: AbortSignal }) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return [];
  });
  try {
    await plugin(bb);
    const recovery = harness.behavior.runService("helper-cleanup");
    await untilCalled(harness, "threads.list");
    const state = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
    assert.equal(state.status, "idle");
    recovery.controller.abort(); await recovery.done;
    assert.equal(harness.inspection.sdk.callsTo("threads.getPluginMetadata").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test("server completes a prediction, keeps the source untouched, and cleans up its helper", async () => {
  const { bb, harness, operations } = fixture();
  try {
    await loadPlugin(bb, harness);
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
test("a helper is stopped, archived and deleted as soon as its thread moves on", async () => {
  const { bb, harness, operations } = fixture();
  const running = { ...worker, status: "active" as const };
  harness.sdk.stub("threads.get", async ({ threadId }) => threadId === "source" ? source : operations.includes("stop:worker") ? worker : running);
  try {
    await loadPlugin(bb, harness);
    await harness.behavior.callRpc("ensure", { threadId: "source" });
    for (let count = 0; count < 50 && harness.inspection.sdk.callsTo("threads.spawn").length === 0; count++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    await harness.behavior.emitThreadEvent("thread.active", { thread: { ...source, status: "active" } });
    await untilCalled(harness, "threads.delete");
    assert.deepEqual(operations, ["stop:worker", "archive:worker", "delete:worker"]);
    const state = await harness.behavior.callRpc("get", { threadId: "source" }) as PredictionState;
    assert.equal(state.status, "idle"); assert.equal(state.suggestion, null);
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});
for (const name of ["thread.active", "thread.failed", "thread.archived", "thread.deleted"] as const) {
  test(`${name} deletes the already archived helper without touching the source`, async () => {
    const { bb, harness, operations } = fixture();
    try {
      await loadPlugin(bb, harness);
      await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness); await untilReleased(harness);
      assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 0);
      await harness.behavior.emitThreadEvent(name, { thread: source });
      await untilCalled(harness, "threads.delete");
      assert.deepEqual(operations, ["stop:worker", "archive:worker", "delete:worker"]);
      assert.deepEqual(harness.inspection.sdk.callsTo("threads.delete"), [[{ threadId: "worker", childThreadsConfirmed: false }]]);
    } finally { await harness.lifecycle.dispose(); }
  });
}
for (const name of ["message.queued", "message.dispatched"] as const) {
  test(`${name} makes the previous helper eligible for deletion`, async () => {
    const { bb, harness } = fixture();
    try {
      await loadPlugin(bb, harness);
      await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness); await untilReleased(harness);
      await harness.behavior.emitThreadEvent(name, { entry: makeQueueEntry({ threadId: "source" }) });
      await untilCalled(harness, "threads.delete");
      assert.deepEqual(harness.inspection.sdk.callsTo("threads.delete"), [[{ threadId: "worker", childThreadsConfirmed: false }]]);
    } finally { await harness.lifecycle.dispose(); }
  });
}
test("regeneration deletes only the superseded helper and keeps the new prediction", async () => {
  const { bb, harness } = fixture();
  try {
    await loadPlugin(bb, harness);
    await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness); await untilReleased(harness);
    await harness.behavior.callRpc("regenerate", { threadId: "source" });
    const state = await untilSettled(harness); await untilCalled(harness, "threads.delete"); await untilReleased(harness, "worker-2");
    assert.equal(state.suggestion, "Show me the diff");
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.delete"), [[{ threadId: "worker", childThreadsConfirmed: false }]]);
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: "worker", pluginId: bb.pluginId });
    assert.equal(metadata?.predictionStale, true);
  } finally { await harness.lifecycle.dispose(); }
});
test("staleness during a slow archive waits for that archive and deletes only once", async () => {
  const { bb, harness, operations } = fixture();
  let releaseArchive = () => {};
  const gate = new Promise<void>(resolve => { releaseArchive = resolve; });
  harness.sdk.stub("threads.archive", async () => { await gate; operations.push("archive:worker"); return { ok: true }; });
  try {
    await loadPlugin(bb, harness);
    await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness); await untilReleased(harness);
    await harness.behavior.emitThreadEvent("thread.active", { thread: source });
    await harness.behavior.emitThreadEvent("thread.archived", { thread: source });
    assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 0);
    releaseArchive(); await untilCalled(harness, "threads.delete");
    assert.deepEqual(operations, ["stop:worker", "archive:worker", "delete:worker"]);
  } finally { releaseArchive(); await harness.lifecycle.dispose(); }
});
test("a helper whose spawn finishes after its source moves on is deleted", async () => {
  const { bb, harness, operations } = fixture();
  let releaseSpawn = () => {};
  const gate = new Promise<void>(resolve => { releaseSpawn = resolve; });
  harness.sdk.stub("threads.spawn", async () => { await gate; return worker; });
  try {
    await loadPlugin(bb, harness);
    await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilCalled(harness, "threads.spawn");
    await harness.behavior.emitThreadEvent("thread.active", { thread: source });
    releaseSpawn(); await untilCalled(harness, "threads.delete");
    assert.deepEqual(operations, ["stop:worker", "archive:worker", "delete:worker"]);
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
  } finally { releaseSpawn(); await harness.lifecycle.dispose(); }
});
test("an unconfirmed stop defers deletion until the helper actually becomes idle", async () => {
  const { bb, harness } = fixture();
  let stopping = true;
  harness.sdk.stub("threads.get", async ({ threadId }) => threadId === "source" ? source : { ...worker, status: stopping ? "stopping" : "idle" });
  try {
    await loadPlugin(bb, harness);
    await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilCalled(harness, "threads.spawn");
    await harness.behavior.emitThreadEvent("thread.active", { thread: source });
    await untilCalled(harness, "threads.updatePluginMetadata");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 0);
    stopping = false;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: worker, lastAssistantText: null }); await untilCalled(harness, "threads.delete");
    assert.equal(harness.inspection.sdk.callsTo("threads.archive").length, 1);
  } finally { await harness.lifecycle.dispose(); }
});
test("a failed archive prevents deletion and disposal retries stale cleanup", async () => {
  const { bb, harness } = fixture();
  let allowArchive = false;
  harness.sdk.stub("threads.archive", async () => { if (!allowArchive) throw new Error("archive unavailable"); return { ok: true }; });
  let disposed = false;
  try {
    await loadPlugin(bb, harness);
    await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness); await untilReleased(harness);
    await harness.behavior.emitThreadEvent("thread.active", { thread: source }); await untilCalled(harness, "threads.updatePluginMetadata");
    assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 0);
    allowArchive = true;
    await harness.lifecycle.dispose(); disposed = true;
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.delete"), [[{ threadId: "worker", childThreadsConfirmed: false }]]);
  } finally { if (!disposed) await harness.lifecycle.dispose(); }
});
test("startup keeps current helpers, deletes stale archived helpers and stops stale running helpers", async () => {
  const { bb, harness, operations } = fixture();
  const rows = [
    { ...worker, id: "current", archivedAt: 1 },
    { ...worker, id: "stale", archivedAt: 1 },
    { ...worker, id: "stale-running", status: "active" as const },
    { ...worker, id: "current-running", status: "active" as const },
    { ...worker, id: "explicitly-stale", archivedAt: 1 },
  ];
  harness.sdk.stub("threads.list", async ({ archived }) => rows.filter(row => !!row.archivedAt === archived));
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => ({ predictionWorker: true, sourceThreadId: "source", sourceSeq: threadId.startsWith("stale") ? 1 : 2, predictionStale: threadId === "explicitly-stale" }));
  try {
    await loadPlugin(bb, harness);
    assert.deepEqual(operations, ["stop:stale-running", "archive:stale-running", "delete:stale-running", "delete:stale", "delete:explicitly-stale"]);
    await harness.behavior.emitThreadEvent("thread.active", { thread: source });
    for (let count = 0; count < 50 && !operations.includes("delete:current"); count++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(operations.includes("delete:current"), "a recovered helper must follow its source even without an open composer");
    assert.ok(!operations.some(operation => operation.endsWith(":current-running")));
  } finally { await harness.lifecycle.dispose(); }
});
test("an unavailable source check preserves its helper until a later source event", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("threads.list", async ({ archived }) => archived ? [{ ...worker, archivedAt: 1 }] : []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ predictionWorker: true, sourceThreadId: "source", sourceSeq: 2 }));
  harness.sdk.stub("threads.get", async ({ threadId }) => { if (threadId === "source") throw new Error("source offline"); return worker; });
  try {
    await loadPlugin(bb, harness);
    assert.ok(warned(harness, "source offline"));
    assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 0);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: source }); await untilCalled(harness, "threads.delete");
  } finally { await harness.lifecycle.dispose(); }
});
test("startup removes helpers whose source was deleted while the plugin was offline", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("threads.list", async ({ archived }) => archived ? [{ ...worker, archivedAt: 1 }] : []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ predictionWorker: true, sourceThreadId: "source", sourceSeq: 2 }));
  harness.sdk.stub("threads.get", async ({ threadId }) => {
    if (threadId === "source") throw Object.assign(new Error("Thread not found"), { status: 404, code: "thread_not_found" });
    return worker;
  });
  try {
    await loadPlugin(bb, harness);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.delete"), [[{ threadId: "worker", childThreadsConfirmed: false }]]);
  } finally { await harness.lifecycle.dispose(); }
});
test("failed deletion is retried on reload without repeating a successful archive", async () => {
  const { bb, harness } = fixture();
  let current = harness;
  let deleted = false;
  let allowDelete = false;
  harness.sdk.stub("threads.list", async ({ archived }) => archived && !deleted ? [{ ...worker, archivedAt: 1 }] : []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ predictionWorker: true, sourceThreadId: "source", sourceSeq: 2, predictionStale: true }));
  harness.sdk.stub("threads.delete", async () => { if (!allowDelete) throw new Error("delete unavailable"); deleted = true; return { ok: true }; });
  try {
    await loadPlugin(bb, harness);
    assert.ok(warned(harness, "delete unavailable"));
    allowDelete = true;
    current = (await harness.lifecycle.reload(plugin)).harness;
    assert.equal(deleted, true);
    assert.equal(current.inspection.sdk.callsTo("threads.archive").length, 0);
  } finally { await current.lifecycle.dispose(); }
});
test("startup scans every archived page before deleting rows", async () => {
  const { bb, harness } = fixture();
  const rows = Array.from({ length: 201 }, (_, index) => ({ ...worker, id: `old-${index}`, archivedAt: 1 }));
  harness.sdk.stub("threads.list", async ({ archived, offset = 0, limit = 100 }) => archived ? rows.slice(offset, offset + limit) : []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ predictionWorker: true }));
  harness.sdk.stub("threads.delete", async ({ threadId }) => { rows.splice(rows.findIndex(row => row.id === threadId), 1); return { ok: true }; });
  try {
    await loadPlugin(bb, harness);
    assert.equal(rows.length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 201);
  } finally { await harness.lifecycle.dispose(); }
});
test("provider archive latency does not delay the suggestion", async () => {
  const { bb, harness } = fixture();
  let openGate: () => void = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  let archived = false;
  harness.sdk.stub("threads.archive", async () => { await gate; archived = true; return { ok: true }; });
  try {
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" });
    assert.equal((await untilSettled(harness)).status, "error");
    assert.equal(harness.inspection.sdk.callsTo("threads.output").length, 0);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.stop"), [[{ threadId: "worker" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
test("startup recovers only this plugin's marked hidden helper threads", async () => {
  const { bb, harness, operations } = fixture({ abandoned: true });
  try {
    await loadPlugin(bb, harness);
    assert.deepEqual(operations, ["stop:worker", "archive:worker", "delete:worker"]);
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
    await loadPlugin(bb, harness);
    assert.deepEqual(operations, ["stop:finished", "archive:finished", "delete:finished", "stop:failed", "archive:failed", "delete:failed", "delete:already", "stop:shown", "archive:shown", "delete:shown"]);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.update"), [[{ threadId: "shown", visibility: "hidden" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
const warned = (harness: ReturnType<typeof fixture>["harness"], text: string) =>
  harness.inspection.logEntries.some(entry => entry.level === "warn" && entry.message.includes(text));
test("the plugin still loads and predicts when startup recovery cannot list threads", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("threads.list", async () => { throw new Error("threads unavailable"); });
  try {
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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

const pickerProviders = [
  { id: "codex", available: true, capabilities: { permissionModes: ["auto"] } },
  { id: "claude-code", available: true, capabilities: { permissionModes: ["accept-edits", "full"] } },
];
const pickerCatalog = {
  providers: pickerProviders,
  models: [{ id: "claude-model", model: "claude-model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }], isDefault: true }],
  modelLoadError: null,
};
const pickerModel = { providerId: "claude-code", model: "claude-model", reasoningLevel: "high" };
test("settings model discovery skips unavailable and full-access-only providers", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("providers.list", async () => [
    { ...pickerProviders[0], available: false },
    { id: "full-only", available: true, capabilities: { permissionModes: ["full"] } },
    pickerProviders[1],
  ]);
  harness.sdk.stub("providers.models", async () => pickerCatalog);
  try {
    await loadPlugin(bb, harness);
    const settings = await harness.behavior.callRpc("model_get", {}) as ModelSettings;
    assert.deepEqual(settings, { selection: null, pickerDefault: pickerModel, catalogError: null });
    assert.deepEqual(harness.inspection.sdk.callsTo("providers.models"), [[{ providerId: "claude-code" }]]);
  } finally { await harness.lifecycle.dispose(); }
});
for (const failure of ["structured", "empty", "throws"] as const) {
  test(`settings model discovery falls back after catalog failure (${failure}) and reports its cause`, async () => {
    const { bb, harness } = fixture();
    harness.sdk.stub("providers.list", async () => pickerProviders);
    harness.sdk.stub("providers.models", async ({ providerId }) => {
      if (providerId === "claude-code") return pickerCatalog;
      if (failure === "throws") throw new Error("catalog request failed");
      return { providers: pickerProviders, models: [], modelLoadError: failure === "structured"
        ? { providerId: "codex", code: "timeout", detail: "catalog request timed out" } : null };
    });
    try {
      await loadPlugin(bb, harness);
      const settings = await harness.behavior.callRpc("model_get", {}) as ModelSettings;
      assert.deepEqual(settings.pickerDefault, pickerModel);
      assert.equal(settings.selection, null, "a picker default must not change the saved prediction model");
      assert.match(settings.catalogError!, /codex/);
      assert.match(settings.catalogError!, failure === "structured" ? /timeout.*catalog request timed out/ : failure === "throws" ? /catalog request failed/ : /no usable.*models/i);
      assert.ok(warned(harness, settings.catalogError!));
      assert.deepEqual(harness.inspection.sdk.callsTo("providers.models"), [[{ providerId: "codex" }], [{ providerId: "claude-code" }]]);
    } finally { await harness.lifecycle.dispose(); }
  });
}
test("settings model discovery tries valid models in default-first order", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("providers.list", async () => [pickerProviders[1]]);
  const valid = pickerCatalog.models[0];
  harness.sdk.stub("providers.models", async () => ({ ...pickerCatalog, models: [
    { ...valid, model: "non-default", isDefault: false },
    { ...valid, model: "invalid-default", defaultReasoningEffort: "" },
    { ...valid, model: "unavailable-route", routeProviderId: "missing-provider" },
    valid,
  ] }));
  try {
    await loadPlugin(bb, harness);
    assert.deepEqual((await harness.behavior.callRpc("model_get", {}) as ModelSettings).pickerDefault, pickerModel);
  } finally { await harness.lifecycle.dispose(); }
});
test("settings model discovery reports listing failures and retry clears recovered errors", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("providers.list", async () => { throw new Error("host disconnected"); });
  try {
    await loadPlugin(bb, harness);
    const failed = await harness.behavior.callRpc("model_get", {}) as ModelSettings;
    assert.equal(failed.pickerDefault, null);
    assert.match(failed.catalogError!, /host disconnected/);
    assert.ok(warned(harness, "host disconnected"));
    harness.sdk.stub("providers.list", async () => [pickerProviders[1]]);
    harness.sdk.stub("providers.models", async () => pickerCatalog);
    assert.deepEqual(await harness.behavior.callRpc("model_get", {}), { selection: null, pickerDefault: pickerModel, catalogError: null });
  } finally { await harness.lifecycle.dispose(); }
});
test("settings model discovery returns all provider failures when none can supply a model", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("providers.list", async () => pickerProviders);
  harness.sdk.stub("providers.models", async ({ providerId }) => ({ providers: pickerProviders, models: [], modelLoadError: { providerId, code: "auth_required", detail: "Sign in again" } }));
  try {
    await loadPlugin(bb, harness);
    const settings = await harness.behavior.callRpc("model_get", {}) as ModelSettings;
    assert.equal(settings.pickerDefault, null);
    assert.match(settings.catalogError!, /codex.*auth_required.*Sign in again/);
    assert.match(settings.catalogError!, /claude-code.*auth_required.*Sign in again/);
    assert.ok(warned(harness, "codex")); assert.ok(warned(harness, "claude-code"));
  } finally { await harness.lifecycle.dispose(); }
});
test("settings model discovery explains when no available provider supports predictions", async () => {
  const { bb, harness } = fixture();
  harness.sdk.stub("providers.list", async () => []);
  try {
    await loadPlugin(bb, harness);
    const settings = await harness.behavior.callRpc("model_get", {}) as ModelSettings;
    assert.equal(settings.pickerDefault, null);
    assert.match(settings.catalogError!, /no available prediction provider/i);
    assert.equal(harness.inspection.sdk.callsTo("providers.models").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

const customModel = { providerId: "other", model: "prediction-model", reasoningLevel: "medium", serviceTier: "fast" };
const customCatalog = { providers: [{ id: "other", capabilities: { permissionModes: ["auto"] } }], models: [{ id: "prediction-alias", model: "prediction-model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }], supportedServiceTiers: [{ id: "fast", label: "Fast" }] }] };
test("separate prediction model persists across reload, routes through the source environment, and resets", async () => {
  const { bb, harness } = fixture();
  let currentHarness = harness;
  try {
    await loadPlugin(bb, harness);
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
    const discoveryCalls = currentHarness.inspection.sdk.callsTo("providers.list").length;
    assert.deepEqual((await currentHarness.behavior.callRpc("model_get", {}) as ModelSettings).selection, saved.selection);
    assert.equal(currentHarness.inspection.sdk.callsTo("providers.list").length, discoveryCalls, "saved choices do not need discovery or a fallback");
    currentHarness.sdk.stub("providers.models", async () => ({ providers: [{ id: "codex", available: true, capabilities: { permissionModes: ["auto"] } }], models: [{ id: "model", model: "model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }));
    const cleared = await currentHarness.behavior.callRpc("model_clear", {}) as ModelSettings;
    assert.equal(cleared.selection, null); assert.equal(cleared.pickerDefault?.model, "model"); assert.equal(cleared.catalogError, null);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
    await loadPlugin(bb, harness);
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
      await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" });
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
    await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" });
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
    await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" });
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
    await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" });
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
    await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" });
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
    await loadPlugin(bb, harness); await harness.behavior.callRpc("ensure", { threadId: "source" }); await untilSettled(harness);
    current = (await harness.lifecycle.reload(plugin)).harness;
    current.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "source" ? { ...source, archivedAt: 1 } : worker);
    const spawns = current.inspection.sdk.callsTo("threads.spawn").length;
    await current.behavior.callRpc("ensure", { threadId: "source" });
    const state = await untilSettled(current);
    assert.equal(state.status, "idle"); assert.equal(state.suggestion, null);
    assert.equal(current.inspection.sdk.callsTo("threads.spawn").length, spawns);
  } finally { await current.lifecycle.dispose(); }
});
