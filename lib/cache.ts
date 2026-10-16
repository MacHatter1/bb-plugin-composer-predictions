import type Database from "better-sqlite3";
import { z } from "zod";
import type { PredictionState } from "../contract";

export interface PredictionCache {
  get(threadId: string): PredictionState | undefined;
  set(state: PredictionState): void;
  delete(threadId: string): void;
}

export const CACHE_MIGRATIONS = [
  // Append migrations; BB tracks their positions across plugin versions.
  `CREATE TABLE IF NOT EXISTS predictions_v1 (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];
const recordSchema = z.object({
  threadId: z.string().min(1).max(200), sourceKey: z.string().min(1).max(128),
  generationId: z.string().min(1).max(200), status: z.enum(["ready", "abstained", "dismissed"]),
  suggestion: z.string().min(1).max(240).refine(text => !/[\u0000-\u001f\u0085\u2028\u2029]/.test(text)).nullable(),
  model: z.string().min(1).max(200), contextCharacters: z.number().int().min(0).max(120000),
  updatedAt: z.number().int().nonnegative(), error: z.null(),
}).strict().refine(state => state.status === "ready" ? state.suggestion !== null : state.suggestion === null);

/** Stores final predictions only; conversation text is never copied into this database. */
export class SqlitePredictionCache implements PredictionCache {
  private read;
  private remove;
  private save;
  private clearAll;
  constructor(db: Database.Database) {
    this.read = db.prepare("SELECT payload FROM predictions_v1 WHERE thread_id = ?");
    this.remove = db.prepare("DELETE FROM predictions_v1 WHERE thread_id = ?");
    this.clearAll = db.prepare("DELETE FROM predictions_v1");
    const upsert = db.prepare("INSERT INTO predictions_v1 (thread_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at");
    const prune = db.prepare("DELETE FROM predictions_v1 WHERE thread_id IN (SELECT thread_id FROM predictions_v1 ORDER BY updated_at DESC, thread_id LIMIT -1 OFFSET 1000)");
    this.save = db.transaction((state: PredictionState) => {
      const record = recordSchema.parse(state);
      upsert.run(record.threadId, JSON.stringify(record), record.updatedAt);
      prune.run();
    });
  }
  get(threadId: string): PredictionState | undefined {
    const row = this.read.get(threadId) as { payload: string } | undefined;
    if (!row) return;
    let decoded: unknown;
    try { decoded = JSON.parse(row.payload); } catch { this.delete(threadId); return; }
    const parsed = recordSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.threadId !== threadId) { this.delete(threadId); return; }
    return parsed.data;
  }
  set(state: PredictionState) { this.save(state); }
  delete(threadId: string) { this.remove.run(threadId); }
  clear() { this.clearAll.run(); }
}
