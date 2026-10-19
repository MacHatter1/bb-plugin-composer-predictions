import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ModelSelection, ModelSettings, rpcContract } from "./contract";
import { MODEL_CHANGED } from "./lib/channels";
import { Button } from "./components/ui/button";

export function ModelSettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const request = useRef(0);
  const apply = useCallback((next: ModelSettings) => {
    setSettings(next); setDraft(next.selection ?? next.pickerDefault); setChoosing(!!next.selection);
  }, []);
  const load = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    void rpc.call("model_get", {}).then(next => {
      if (mounted.current && id === request.current) { apply(next); setError(null); }
    }).catch(cause => {
      if (mounted.current && id === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (mounted.current && id === request.current) setLoading(false); });
  }, [rpc, apply]);
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; request.current++; }; }, [load]);
  useRealtime(MODEL_CHANGED, () => { if (!busy.current) load(); });
  async function save(reset = false) {
    if (busy.current || (!reset && !draft)) return;
    busy.current = true; request.current++; setSaving(true); setError(null);
    try {
      const next = reset ? await rpc.call("model_clear", {}) : await rpc.call("model_set", draft!);
      if (mounted.current) apply(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { busy.current = false; if (mounted.current) { setSaving(false); setLoading(false); } }
  }
  const configured = !!settings?.selection;
  const unsaved = choosing && JSON.stringify(draft) !== JSON.stringify(settings?.selection);
  const visibleError = error ?? settings?.catalogError;
  return <div className="space-y-3 text-sm">
    <p role="status" className="text-muted-foreground">{loading ? "Loading prediction model…" : saving ? "Saving prediction model…" : configured ? "Using a separate model for predictions." : "Using each conversation’s model."}</p>
    {choosing && draft ? <div className="space-y-3">
      <div aria-label="Prediction model"><ProviderModelPicker value={draft} onChange={next => setDraft(next)} disabled={saving || loading} align="start" className="w-full" /></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={saving || loading || !unsaved} onClick={() => { void save(); }}>Save prediction model</Button>
        <Button type="button" variant="outline" size="sm" disabled={saving || loading} onClick={() => {
          if (configured) void save(true);
          else { setChoosing(false); setDraft(settings?.pickerDefault ?? null); setError(null); }
        }}>{configured ? "Use conversation model" : "Cancel"}</Button>
        {unsaved && !saving ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </div> : !loading ? <Button type="button" variant="outline" size="sm" disabled={!draft || saving} onClick={() => setChoosing(true)}>Choose a separate model</Button> : null}
    {!loading && (!draft || settings?.catalogError) ? <div className="flex items-center gap-2">{!draft ? <span className="text-muted-foreground">The model catalog is unavailable.</span> : null}<Button type="button" variant="outline" size="sm" onClick={load} disabled={saving}>Retry</Button></div> : null}
    {visibleError ? <p role="alert" className="whitespace-pre-line text-destructive">{visibleError}</p> : null}
    <p className="text-xs text-muted-foreground">Saved choices apply to predictions only. The selected provider and model must be available on the conversation’s machine.</p>
  </div>;
}
