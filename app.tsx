import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useComposer, useRealtime, useRealtimeConnectionState, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { PredictionState, rpcContract } from "./contract";
import { mountGhostDecorations, refreshGhost, registerGhost } from "./lib/ghost";
import { MODEL_CHANGED } from "./lib/channels";
import { ModelSettingsSection } from "./model-settings";

function PredictionBridge() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const connection = useRealtimeConnectionState();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [prediction, setPrediction] = useState<PredictionState | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const latest = useRef({ composer, prediction, enabled: settings.values?.enabled !== false, threadId });
  latest.current = { composer, prediction, enabled: settings.values?.enabled !== false, threadId };
  const sequence = useRef(0);
  const mounted = useRef(false);
  const dismissedGeneration = useRef<string | null>(null);
  const dismissOnArrival = useRef(false);

  const load = useCallback((ensure = false) => {
    if (!threadId) return;
    const request = ++sequence.current;
    void rpc.call(ensure ? "ensure" : "get", { threadId }).then(state => {
      if (mounted.current && request === sequence.current && latest.current.threadId === state.threadId) setPrediction(state);
    }).catch(() => { if (mounted.current && request === sequence.current) setPrediction(null); });
  }, [rpc, threadId]);
  useEffect(() => {
    mounted.current = true; dismissedGeneration.current = null; dismissOnArrival.current = false; setPrediction(null);
    if (latest.current.composer.isEmpty && !latest.current.composer.isRunning) load(true);
    return () => { mounted.current = false; sequence.current++; };
  }, [threadId, load]);
  useEffect(() => {
    if (composer.isEmpty && !composer.isRunning && settings.values?.enabled !== false) load(true);
  }, [composer.isEmpty, composer.isRunning, settings.values?.enabled, connection, load]);
  useRealtime("prediction-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) load();
  });
  useRealtime(MODEL_CHANGED, () => {
    setPrediction(null);
    if (latest.current.composer.isEmpty && !latest.current.composer.isRunning && latest.current.enabled) load(true);
  });
  const dismiss = useCallback(() => {
    const current = latest.current;
    const state = current.prediction;
    if (!current.threadId || current.composer.isRunning) return;
    dismissOnArrival.current = true;
    if (!state?.generationId || state.threadId !== current.threadId) return;
    dismissOnArrival.current = false;
    if (state.generationId === dismissedGeneration.current || state.status === "dismissed") return;
    dismissedGeneration.current = state.generationId;
    sequence.current++;
    setPrediction({ ...state, status: "dismissed", suggestion: null });
    void rpc.call("dismiss", { threadId: current.threadId, generationId: state.generationId }).catch(() => {});
  }, [rpc]);
  useEffect(() => {
    if (composer.isRunning) {
      dismissOnArrival.current = false;
      if (prediction?.generationId) dismissedGeneration.current = prediction.generationId;
    } else if (!composer.isEmpty || dismissOnArrival.current) dismiss();
  }, [composer.isEmpty, composer.isRunning, prediction, dismiss]);

  useEffect(() => {
    if (!anchor.current) return;
    return registerGhost({
      anchor: anchor.current,
      snapshot() {
        const { composer, prediction: state, enabled, threadId } = latest.current;
        return {
          suggestion: state?.suggestion ?? null, generationId: state?.generationId ?? null, compact: composer.layout === "compact",
          eligible: enabled && !!threadId && state?.threadId === threadId && state.status === "ready" && state.generationId !== dismissedGeneration.current && !dismissOnArrival.current && composer.isEmpty && !composer.isRunning && !composer.isSubmitting,
        };
      },
      accept() {
        const { composer, prediction: state, enabled, threadId } = latest.current;
        if (!enabled || !state?.suggestion || state.status !== "ready" || state.threadId !== threadId || !composer.isEmpty || composer.isRunning || composer.isSubmitting || state.generationId === dismissedGeneration.current || dismissOnArrival.current) return false;
        let applied = false;
        composer.replace(current => {
          if (current.text.trim() || current.mentions.length || current.attachments.length) return current;
          applied = true;
          return { text: state.suggestion!, mentions: [] };
        });
        if (applied) { dismiss(); composer.focus(); }
        return applied;
      },
      dismiss,
    });
  }, [composer.key, dismiss]);
  useEffect(() => { refreshGhost(); });
  const available = prediction?.threadId === threadId && prediction?.status === "ready" && prediction.generationId !== dismissedGeneration.current && !dismissOnArrival.current && composer.isEmpty && !composer.isRunning && !composer.isSubmitting && settings.values?.enabled !== false;
  return <span ref={anchor} data-composer-prediction-bridge="" className="sr-only" role="status" aria-live="polite">{available ? `Suggestion available. Press Tab to insert: ${prediction.suggestion}` : ""}</span>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "model", title: "Prediction model", description: "Choose a separate provider and model for autocomplete suggestions, or use each conversation’s model.", component: ModelSettingsSection });
  app.composer.customize({ id: "predictions", scopes: ["thread"], banners: [{ id: "prediction-bridge", chrome: "bare", component: PredictionBridge }] });
  app.contentScripts.register({ id: "prediction-ghost", mount: () => mountGhostDecorations(document) });
});
