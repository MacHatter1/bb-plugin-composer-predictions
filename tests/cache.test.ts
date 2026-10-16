import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CACHE_MIGRATIONS, SqlitePredictionCache } from "../lib/cache.ts";
import { PredictionCoordinator } from "../lib/coordinator.ts";
import type { PredictionState } from "../contract.ts";

const ready: PredictionState = { threadId: "source", sourceKey: "context-fingerprint", generationId: "generation", status: "ready", suggestion: "Show me the diff", model: "model", contextCharacters: 100, updatedAt: 1, error: null };
function open(path = ":memory:") {
  const database = new Database(path);
  for (const migration of CACHE_MIGRATIONS) database.exec(migration);
  return { database, cache: new SqlitePredictionCache(database) };
}
test("prediction cache survives closing and reopening the database without storing conversation text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-prediction-cache-"));
  const file = join(directory, "data.db");
  let current = open(file);
  try {
    current.cache.set(ready); current.database.close();
    current = open(file);
    assert.deepEqual(current.cache.get("source"), ready);
    const row = current.database.prepare("SELECT payload FROM predictions_v1").get() as { payload: string };
    assert.deepEqual(Object.keys(JSON.parse(row.payload)).sort(), Object.keys(ready).sort());
    current.cache.delete("source"); assert.equal(current.cache.get("source"), undefined);
  } finally { current.database.close(); await rm(directory, { recursive: true, force: true }); }
});
test("cache discards malformed, mismatched, and nonfinal records and bounds disk entries", () => {
  const { database, cache } = open();
  try {
    const write = database.prepare("INSERT OR REPLACE INTO predictions_v1 VALUES (?, ?, ?)");
    for (const payload of ["{broken", JSON.stringify({ ...ready, threadId: "other" }), JSON.stringify({ ...ready, status: "generating" }), JSON.stringify({ ...ready, suggestion: "first\nsecond" })]) {
      write.run("source", payload, 1); assert.equal(cache.get("source"), undefined);
      assert.equal((database.prepare("SELECT count(*) AS n FROM predictions_v1").get() as { n: number }).n, 0);
    }
    for (let index = 0; index < 1001; index++) cache.set({ ...ready, threadId: `thread-${index}`, suggestion: "x".repeat(240), updatedAt: index });
    assert.equal((database.prepare("SELECT count(*) AS n FROM predictions_v1").get() as { n: number }).n, 1000);
    assert.equal(cache.get("thread-0"), undefined); assert.ok(cache.get("thread-1000"));
    cache.clear(); assert.equal(cache.get("thread-1000"), undefined);
  } finally { database.close(); }
});
test("restored predictions stay hidden until source validation and are not resurrected after cancellation", async () => {
  const { database, cache } = open();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const engine = new PredictionCoordinator({
    cache, source: async () => { await gate; return { key: ready.sourceKey!, model: "model", conversation: "private context" }; },
    generate: async () => assert.fail("a cancelled validation must not generate"), changed() {}, log: assert.fail,
  });
  try {
    cache.set(ready);
    assert.equal(engine.get("source").suggestion, null);
    assert.equal(engine.request("source").suggestion, null);
    engine.clear("source"); release(); await engine.settled("source");
    await engine.dispose();
    assert.equal(cache.get("source"), undefined); assert.equal(engine.get("source").suggestion, null);
  } finally { release(); await engine.dispose(); database.close(); }
});
test("cache failures do not prevent a fresh prediction", async () => {
  const engine = new PredictionCoordinator({
    cache: { get() { throw new Error("read failed"); }, set() { throw new Error("write failed"); }, delete() { throw new Error("delete failed"); } },
    source: async () => ({ key: "context", model: "model", conversation: "private context" }),
    generate: async () => "Show the diff", changed() {}, log() {},
  });
  try { engine.request("source"); await engine.settled("source"); assert.equal(engine.get("source").suggestion, "Show the diff"); }
  finally { await engine.dispose(); }
});
test("typing during restored-context validation persists dismissal against that saved context", async () => {
  const { database, cache } = open();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = { key: ready.sourceKey!, model: "model", conversation: "context" };
  const engine = new PredictionCoordinator({ cache, source: async () => { await gate; return source; }, generate: async () => assert.fail("must not generate"), changed() {}, log: assert.fail });
  let restored: PredictionCoordinator | undefined;
  try {
    cache.set(ready);
    const pending = engine.request("source");
    engine.dismiss("source", pending.generationId); release(); await engine.dispose();
    assert.equal(cache.get("source")?.status, "dismissed");
    restored = new PredictionCoordinator({ cache, source: async () => source, generate: async () => assert.fail("dismissal must survive"), changed() {}, log: assert.fail });
    restored.request("source"); await restored.settled("source");
    assert.equal(restored.get("source").status, "dismissed");
  } finally { release(); await engine.dispose(); await restored?.dispose(); database.close(); }
});

test("temporary restoration failures preserve a saved result for a healthy retry", async () => {
  const { database, cache } = open();
  let unavailable = true;
  let generations = 0;
  const engine = new PredictionCoordinator({
    cache, source: async () => {
      if (unavailable) throw new Error("temporary provider discovery failure");
      return { key: ready.sourceKey!, model: "model", conversation: "context" };
    },
    generate: async () => { generations++; return "Unnecessary regeneration"; }, changed() {}, log() {},
  });
  try {
    cache.set(ready);
    engine.request("source"); await engine.settled("source");
    assert.equal(engine.get("source").status, "error");
    assert.equal(engine.get("source").suggestion, null);
    assert.deepEqual(cache.get("source"), ready, "failed validation must leave the saved result intact");
    unavailable = false;
    engine.request("source"); await engine.settled("source");
    assert.equal(engine.get("source").generationId, ready.generationId);
    assert.equal(engine.get("source").suggestion, ready.suggestion);
    assert.equal(generations, 0);
    unavailable = true;
    engine.request("source"); await engine.settled("source");
    unavailable = false;
    engine.request("source"); await engine.settled("source");
    assert.equal(engine.get("source").status, "ready", "a warm validation error must also recover");
    assert.equal(generations, 0);
  } finally { await engine.dispose(); database.close(); }
});

test("a typing dismissal arriving after restoration still targets the restored prediction", async () => {
  const { database, cache } = open();
  let context = { key: ready.sourceKey!, model: "model", conversation: "context" };
  const engine = new PredictionCoordinator({ cache, source: async () => context, generate: async () => "New context prediction", changed() {}, log: assert.fail });
  try {
    cache.set(ready);
    const pending = engine.request("source");
    await engine.settled("source");
    assert.equal(engine.get("source").generationId, ready.generationId);
    engine.dismiss("source", pending.generationId);
    assert.equal(engine.get("source").status, "dismissed");
    assert.equal(cache.get("source")?.status, "dismissed");
    context = { ...context, key: "new-context" };
    engine.request("source"); await engine.settled("source");
    engine.dismiss("source", pending.generationId);
    assert.equal(engine.get("source").status, "ready", "the alias must not dismiss a later context");
    assert.equal(engine.get("source").suggestion, "New context prediction");
  } finally { await engine.dispose(); database.close(); }
});

test("early typing binds dismissal to the actual context after an offline conversation change", async () => {
  const { database, cache } = open();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = { key: "conversation-moved-offline", model: "model", conversation: "new conversation" };
  let generations = 0;
  const engine = new PredictionCoordinator({ cache, source: async () => { await gate; return current; }, generate: async () => { generations++; return "Must stay dismissed"; }, changed() {}, log: assert.fail });
  let restored: PredictionCoordinator | undefined;
  try {
    cache.set(ready);
    const pending = engine.request("source");
    engine.dismiss("source", pending.generationId);
    release(); await engine.settled("source");
    engine.request("source"); await engine.settled("source");
    assert.equal(generations, 0, "clearing a typed draft must not regenerate in the same current context");
    assert.equal(engine.get("source").status, "dismissed");
    assert.equal(cache.get("source")?.sourceKey, current.key);
    await engine.dispose();
    restored = new PredictionCoordinator({ cache, source: async () => current, generate: async () => { generations++; return "Must stay dismissed after reload"; }, changed() {}, log: assert.fail });
    restored.request("source"); await restored.settled("source");
    assert.equal(restored.get("source").status, "dismissed");
    assert.equal(generations, 0);
  } finally { release(); await engine.dispose(); await restored?.dispose(); database.close(); }
});

test("typing after a failed warm validation remains dismissed when the changed source recovers", async () => {
  const { database, cache } = open();
  let unavailable = false;
  let context = { key: ready.sourceKey!, model: "model", conversation: "context" };
  let generations = 0;
  const engine = new PredictionCoordinator({
    cache, source: async () => { if (unavailable) throw new Error("temporary source failure"); return context; },
    generate: async () => { generations++; return "Should stay dismissed"; }, changed() {}, log() {},
  });
  try {
    cache.set(ready); engine.request("source"); await engine.settled("source");
    context = { ...context, key: "new-context" }; unavailable = true;
    engine.request("source"); await engine.settled("source");
    assert.equal(engine.get("source").sourceKey, null, "failed validation must not claim the previous key is current");
    engine.dismiss("source", engine.get("source").generationId);
    unavailable = false;
    engine.request("source"); await engine.settled("source");
    assert.equal(engine.get("source").status, "dismissed");
    assert.equal(cache.get("source")?.sourceKey, context.key);
    assert.equal(generations, 0);
  } finally { await engine.dispose(); database.close(); }
});
