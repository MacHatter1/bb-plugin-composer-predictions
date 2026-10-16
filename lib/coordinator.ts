import { randomUUID } from "node:crypto";
import type { PredictionState } from "../contract.ts";
import type { PredictionCache } from "./cache";

export interface Source { key: string; model: string; conversation: string }
interface Adapter<T extends Source> {
  source(threadId: string, signal: AbortSignal): Promise<T | null>;
  generate(threadId: string, source: T, signal: AbortSignal): Promise<string | null>;
  changed(threadId: string): void;
  log(error: unknown): void;
  cache?: PredictionCache;
}
type Job = { controller: AbortController; promise: Promise<void>; validating: boolean; dismissed: boolean };
export class PredictionCoordinator<T extends Source = Source> {
  private states = new Map<string, PredictionState>();
  private jobs = new Map<string, Job>();
  private inflight = new Set<Job>();
  private restoredIds = new Map<string, { pending: string; restored: string }>();
  private running = 0;
  private waiters = new Set<() => void>();
  private disposed = false;
  private adapter: Adapter<T>;
  private concurrency: number;
  constructor(adapter: Adapter<T>, concurrency = 2) { this.adapter = adapter; this.concurrency = concurrency; }
  get(threadId: string): PredictionState {
    return this.states.get(threadId) ?? { threadId, sourceKey: null, generationId: null, status: "idle", suggestion: null, model: null, contextCharacters: 0, updatedAt: 0, error: null };
  }
  private set(threadId: string, patch: Partial<PredictionState>) {
    if (this.disposed) return;
    const state = { ...this.get(threadId), ...patch, updatedAt: Date.now() };
    this.states.set(threadId, state);
    if (this.restoredIds.get(threadId)?.restored !== state.generationId) this.restoredIds.delete(threadId);
    this.withCache(cache => {
      if (["ready", "abstained", "dismissed"].includes(state.status) && state.sourceKey && state.generationId) cache.set(state);
      // Failed or unfinished validation proves nothing about a saved result.
      // Only explicit invalidation or a confirmed new generation removes it.
      else if (state.status === "idle" || (state.status === "generating" && state.sourceKey)) cache.delete(threadId);
    });
    // Bound the hot cache independently of the durable cache.
    if (this.states.size > 1000) {
      const oldest = this.states.keys().next().value;
      if (oldest && !this.jobs.has(oldest)) { this.states.delete(oldest); this.restoredIds.delete(oldest); }
    }
    this.adapter.changed(threadId);
  }
  private withCache<R>(action: (cache: PredictionCache) => R): R | undefined {
    if (!this.adapter.cache) return;
    try { return action(this.adapter.cache); }
    catch (error) { this.adapter.log(`Prediction cache unavailable: ${String(error)}`); }
  }
  clear(threadId: string) {
    this.restoredIds.delete(threadId);
    this.jobs.get(threadId)?.controller.abort();
    this.jobs.delete(threadId);
    this.set(threadId, { sourceKey: null, generationId: null, status: "idle", suggestion: null, model: null, contextCharacters: 0, error: null });
  }
  dismiss(threadId: string, generationId: string | null) {
    const state = this.get(threadId);
    const restored = this.restoredIds.get(threadId);
    const matches = generationId === state.generationId || (restored?.pending === generationId && restored.restored === state.generationId);
    if (!generationId || !state.generationId || !matches || state.status === "dismissed") return state;
    const job = this.jobs.get(threadId);
    if (job?.validating || !state.sourceKey) {
      const known = state.sourceKey ? state : this.withCache(cache => cache.get(threadId));
      if (known?.sourceKey) this.withCache(cache => cache.set({ ...known, generationId: state.generationId, status: "dismissed", suggestion: null, error: null, updatedAt: Date.now() }));
    }
    if (job?.validating) {
      // Finish the read-only lookup so dismissal belongs to the actual current
      // context, which may differ from the saved context after an offline turn.
      job.dismissed = true;
      this.set(threadId, { sourceKey: null, status: "dismissed", suggestion: null, error: null });
      return this.get(threadId);
    }
    this.jobs.get(threadId)?.controller.abort();
    this.jobs.delete(threadId);
    this.set(threadId, { status: "dismissed", suggestion: null, error: null });
    return this.get(threadId);
  }
  request(threadId: string, force = false): PredictionState {
    if (this.disposed || this.jobs.has(threadId)) return this.get(threadId);
    const previous = this.get(threadId);
    const saved = force ? undefined : this.withCache(cache => cache.get(threadId));
    if (force) this.withCache(cache => cache.delete(threadId));
    const job: Job = { controller: new AbortController(), promise: Promise.resolve(), validating: true,
      dismissed: !force && previous.status === "dismissed" && previous.sourceKey === null };
    this.jobs.set(threadId, job);
    this.inflight.add(job);
    if (force || !previous.generationId) this.set(threadId, { generationId: randomUUID(), status: "generating", suggestion: null, error: null });
    job.promise = Promise.resolve().then(async () => {
      const signal = job.controller.signal;
      try {
        const source = await this.adapter.source(threadId, signal);
        signal.throwIfAborted();
        job.validating = false;
        if (!source) { this.set(threadId, { sourceKey: null, generationId: null, status: "idle", suggestion: null }); return; }
        if (job.dismissed) {
          this.set(threadId, { sourceKey: source.key, model: source.model, contextCharacters: source.conversation.length, status: "dismissed", suggestion: null, error: null });
          return;
        }
        if (!force && previous.sourceKey === source.key && ["ready", "abstained", "dismissed"].includes(previous.status)) return;
        if (saved?.sourceKey === source.key) {
          const pending = this.get(threadId).generationId;
          if (pending && saved.generationId && pending !== saved.generationId) this.restoredIds.set(threadId, { pending, restored: saved.generationId });
          this.set(threadId, saved); return;
        }
        this.set(threadId, { sourceKey: source.key, generationId: !force && previous.generationId ? randomUUID() : this.get(threadId).generationId, model: source.model, contextCharacters: source.conversation.length, status: "generating", suggestion: null, error: null });
        await this.acquire(signal);
        let suggestion: string | null;
        try { suggestion = await this.adapter.generate(threadId, source, signal); }
        finally { this.running--; this.waiters.forEach(wake => wake()); }
        signal.throwIfAborted();
        this.set(threadId, { status: suggestion === null ? "abstained" : "ready", suggestion });
      } catch (error) {
        if (!signal.aborted) {
          this.adapter.log(error);
          if (!job.dismissed) this.set(threadId, {
            ...(job.validating ? { sourceKey: null, model: null, contextCharacters: 0 } : {}),
            status: "error", suggestion: null, error: "Prediction unavailable",
          });
        }
      } finally {
        this.inflight.delete(job);
        if (this.jobs.get(threadId) === job) this.jobs.delete(threadId);
      }
    });
    return this.get(threadId);
  }
  private async acquire(signal: AbortSignal) {
    while (this.running >= this.concurrency) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
        this.waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    signal.throwIfAborted();
    this.running++;
  }
  async settled(threadId: string) { await this.jobs.get(threadId)?.promise; }
  async dispose() {
    this.disposed = true;
    const jobs = [...this.inflight];
    jobs.forEach(job => job.controller.abort());
    await Promise.allSettled(jobs.map(job => job.promise));
    this.jobs.clear(); this.states.clear(); this.restoredIds.clear();
  }
}
