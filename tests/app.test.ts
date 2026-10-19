import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ModelSelection, ModelSettings, PredictionState } from "../contract.ts";
import { refreshGhost } from "../lib/ghost.ts";
import plugin from "../server.ts";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
for (const name of ["window", "document", "navigator", "HTMLElement", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
const app = await loadPluginApp(() => import("../app.tsx"));
const initial: PredictionState = { threadId: "a", sourceKey: "context", generationId: "one", status: "ready", suggestion: "Show me the diff", model: "test", contextCharacters: 100, updatedAt: 1, error: null };

async function fixture(ensure?: () => Promise<PredictionState>) {
  let state = { ...initial };
  const shell = document.createElement("div"); shell.setAttribute("data-promptbox-shell", "");
  shell.innerHTML = '<form data-promptbox><div data-promptbox-editor-content><div contenteditable="true"><p class="is-editor-empty"><br></p></div></div></form>';
  document.body.append(shell);
  const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "a" } }, settings: { enabled: true },
    rpc: {
      ensure: ensure ?? (() => state), get: () => state,
      dismiss(input: unknown) { const data = input as { generationId: string }; if (data.generationId === state.generationId) state = { ...state, status: "dismissed", suggestion: null }; return state; },
    },
  });
  shell.prepend(slot.container);
  const scripts = await mountPluginContentScripts(app, { pluginId: "composer-predictions", generation: 1 });
  await act(async () => {}); refreshGhost();
  const editor = shell.querySelector<HTMLElement>("[contenteditable]")!;
  return {
    slot, editor,
    visible: () => !!shell.querySelector<HTMLElement>("[data-composer-prediction-ghost]:not([hidden])"),
    async update(next: PredictionState) { state = next; await slot.behavior.emitRealtime("prediction-changed", { threadId: "a" }); },
    async press(key: string) { let event!: KeyboardEvent; await act(async () => { event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); editor.dispatchEvent(event); }); return event; },
    async cleanup() { slot.lifecycle.unmount(); await scripts.lifecycle.dispose(); shell.remove(); },
  };
}
test("public composer integration accepts a draft without submitting and allows explicit regeneration", async () => {
  const f = await fixture();
  try {
    await waitFor(() => assert.equal(f.visible(), true));
    assert.equal((await f.press("Tab")).defaultPrevented, true);
    assert.equal(f.slot.inspection.composer.text, "Show me the diff");
    assert.deepEqual(f.slot.inspection.composer.submits, []);
    assert.ok(f.slot.inspection.composer.focusCount > 0);
    await f.slot.behavior.setComposerText("");
    await f.update({ ...initial, generationId: "two", updatedAt: 1 });
    await waitFor(() => assert.equal(f.visible(), true));
    assert.equal((await f.press("Tab")).defaultPrevented, true);
    assert.deepEqual(f.slot.inspection.composer.submits, []);
  } finally { await f.cleanup(); }
});
test("touch acceptance uses the public composer API without submitting", async () => {
  const f = await fixture();
  try {
    await waitFor(() => assert.equal(f.visible(), true));
    const touch = async (type: string, x: number) => {
      const point = { identifier: 1, clientX: x, clientY: 60 };
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : [point] },
        changedTouches: { value: [point] },
      });
      await act(async () => { f.editor.dispatchEvent(event); });
    };
    await touch("touchstart", 80);
    await touch("touchmove", 140);
    assert.equal(f.slot.inspection.composer.text, "");
    await touch("touchend", 160);
    assert.equal(f.slot.inspection.composer.text, "Show me the diff");
    assert.deepEqual(f.slot.inspection.composer.submits, []);
    assert.ok(f.slot.inspection.composer.focusCount > 0);
    await waitFor(() => assert.equal(f.visible(), false));
  } finally { await f.cleanup(); }
});
test("typing and clearing before the first RPC response dismisses the arriving generation", async () => {
  let release = (_state: PredictionState) => {};
  const held = new Promise<PredictionState>(resolve => { release = resolve; });
  const f = await fixture(() => held);
  try {
    await act(async () => { f.editor.dispatchEvent(new dom.window.Event("beforeinput", { bubbles: true })); });
    await f.slot.behavior.setComposerText("my draft"); await f.slot.behavior.setComposerText("");
    await act(async () => { release({ ...initial, status: "generating", suggestion: null }); });
    await waitFor(() => assert.ok(f.slot.inspection.rpcCalls.some(call => call.method === "dismiss" && (call.input as { generationId: string }).generationId === "one")));
    await f.update(initial); // A late realtime read must not resurrect this generation.
    assert.equal(f.visible(), false);
    assert.equal((await f.press("Tab")).defaultPrevented, false);
    assert.equal(f.slot.inspection.composer.text, "");
    await f.update({ ...initial, generationId: "next-turn" });
    await waitFor(() => assert.equal(f.visible(), true));
  } finally { await f.cleanup(); }
});

test("settings picker saves a separate model, reports failures, and restores conversation mode", async () => {
  const seed: ModelSelection = { providerId: "codex", model: "prediction-model", reasoningLevel: "low" };
  let saved: ModelSelection | null = null;
  let failSave = true;
  const current = (): ModelSettings => ({ selection: saved, pickerDefault: saved ?? seed, catalogError: null });
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
    model_get: current,
    model_set(input: unknown) { if (failSave) throw new Error("Provider is offline"); saved = input as ModelSelection; return current(); },
    model_clear() { saved = null; return current(); },
  } });
  try {
    await slot.findByText("Using each conversation’s model.");
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Choose a separate model" })); });
    assert.equal(slot.inspection.rpcCalls.filter(call => call.method === "model_set").length, 0);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Save prediction model" })); });
    await slot.findByRole("alert"); assert.equal(saved, null);
    assert.match(slot.getByRole("alert").textContent!, /Provider is offline/);
    failSave = false;
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Save prediction model" })); });
    await slot.findByText("Using a separate model for predictions.");
    assert.deepEqual(saved, seed);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Use conversation model" })); });
    await slot.findByText("Using each conversation’s model."); assert.equal(saved, null);
    assert.deepEqual(slot.inspection.composer.submits, []);
  } finally { slot.lifecycle.unmount(); }
});
const settingsProvider = { id: "claude-code", available: true, capabilities: { permissionModes: ["accept-edits", "full"] } };
const settingsCatalog = {
  providers: [settingsProvider],
  models: [{ id: "claude-model", model: "claude-model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }], isDefault: true }],
  modelLoadError: null,
};
test("settings surfaces a catalog error from the server and Retry restores the chooser", async () => {
  let recovered = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "composer-predictions", sdk: {
    threads: { list: async () => [] },
    providers: {
      list: async () => [settingsProvider],
      models: async () => recovered ? settingsCatalog : { ...settingsCatalog, models: [], modelLoadError: { providerId: "claude-code", code: "auth_required", detail: "Sign in again" } },
    },
  } });
  await plugin(bb);
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: { model_get: () => harness.behavior.callRpc("model_get", {}) } });
  try {
    assert.match((await slot.findByRole("alert")).textContent!, /claude-code.*auth_required.*Sign in again/);
    assert.equal((slot.getByRole("button", { name: "Choose a separate model" }) as HTMLButtonElement).disabled, true);
    recovered = true;
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Retry" })); });
    await waitFor(() => assert.equal((slot.getByRole("button", { name: "Choose a separate model" }) as HTMLButtonElement).disabled, false));
    assert.equal(slot.queryByRole("alert"), null);
  } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
});
test("settings keeps a fallback usable while showing the failed provider and saves only on request", async () => {
  const failedProvider = { ...settingsProvider, id: "codex" };
  const { bb, harness } = createFakePluginHost({ pluginId: "composer-predictions", sdk: {
    threads: { list: async () => [] },
    providers: {
      list: async () => [failedProvider, settingsProvider],
      models: async ({ providerId } = {}) => {
        if (providerId === "codex") throw new Error("catalog request failed");
        return settingsCatalog;
      },
    },
  } });
  await plugin(bb);
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
    model_get: () => harness.behavior.callRpc("model_get", {}),
    model_set: input => harness.behavior.callRpc("model_set", input),
  } });
  try {
    assert.match((await slot.findByRole("alert")).textContent!, /codex.*catalog request failed/);
    assert.equal((slot.getByRole("button", { name: "Choose a separate model" }) as HTMLButtonElement).disabled, false);
    assert.equal((await harness.behavior.callRpc("model_get", {}) as ModelSettings).selection, null);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Choose a separate model" })); });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Save prediction model" })); });
    await slot.findByText("Using a separate model for predictions.");
    assert.deepEqual((await harness.behavior.callRpc("model_get", {}) as ModelSettings).selection, { providerId: "claude-code", model: "claude-model", reasoningLevel: "high" });
    assert.equal(slot.queryByRole("alert"), null);
  } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
});
test("a model change refreshes only an empty idle composer", async () => {
  const f = await fixture();
  try {
    const before = f.slot.inspection.rpcCalls.filter(call => call.method === "ensure").length;
    await f.slot.behavior.emitRealtime("prediction-model-changed", {});
    assert.equal(f.slot.inspection.rpcCalls.filter(call => call.method === "ensure").length, before + 1);
    await f.slot.behavior.setComposerText("My unsent draft");
    const withDraft = f.slot.inspection.rpcCalls.filter(call => call.method === "ensure").length;
    await f.slot.behavior.emitRealtime("prediction-model-changed", {});
    assert.equal(f.slot.inspection.rpcCalls.filter(call => call.method === "ensure").length, withDraft);
    assert.equal(f.slot.inspection.composer.text, "My unsent draft");
  } finally { await f.cleanup(); }
});
