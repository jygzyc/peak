import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { SessionManager } from "../dist/session/session-manager.js";
import { FederatedGraph } from "../dist/graph/federated-graph.js";
import type { TaskConfig } from "../dist/agent/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "peak-sqlite-"));
}

function config(): TaskConfig {
  const p = {
    runtime: { worker: "w" },
    prompt: { file: "prompts/x.md" },
    context: { graphView: "full" as const },
    permissions: [],
    output: { contract: "main_decision" as const },
    role: "test",
  };
  return {
    task: { target: "T", goal: "G" },
    profiles: { planner: p, explorer: p, evaluator: p },
    workers: { w: { kind: "mock" } },
    workflow: { limits: {} },
  };
}

test("SqliteGraph: createProject + addFact + resolveFact roundtrip", () => {
  const dir = tempDir();
  const dbPath = join(dir, "test.db");
  const g = new SqliteGraph(dbPath);

  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  assert.equal(p.status, "active");
  assert.equal(g.facts(p.id).length, 0);

  const f = g.addFact(p.id, { description: "test fact", source: "explorer", confidence: 0.8 });
  assert.equal(f.id, "f001");
  assert.equal(f.status, "candidate");

  g.resolveFact(p.id, f.id, { decision: "pass", reason: "ok" });
  assert.equal(g.getFact(p.id, f.id)!.status, "pass");

  g.close();
});

test("SqliteGraph: events(sinceSeq) remains ascending", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "events.db"));
  const p = g.createProject({
    session: "events", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const first = g.logEvent(p.id, "one");
  g.logEvent(p.id, "two");
  g.logEvent(p.id, "three");
  const events = g.events(p.id, first.seq);
  assert.deepEqual(events.map((event) => event.type), ["two", "three"]);
  assert.ok(events[0]!.seq < events[1]!.seq);
  g.close();
});

test("SqliteGraph: deferred fact persists and can be promoted", () => {
  const dir = tempDir();
  const dbPath = join(dir, "test.db");
  const g = new SqliteGraph(dbPath);
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const f = g.addFact(p.id, { description: "conditional", source: "explorer", confidence: 0.8 });
  g.resolveFact(p.id, f.id, { decision: "pending", reason: "needs device state", requiredConditions: ["device unlocked"] });
  assert.equal(g.getFact(p.id, f.id)!.status, "pending");
  assert.notEqual(g.getFact(p.id, f.id)!.status, "blocked");
  assert.deepEqual(g.getFact(p.id, f.id)!.requiredConditions, ["device unlocked"]);
  assert.equal(g.progress(p.id).pendingFacts, 1);
  g.close();

  const g2 = new SqliteGraph(dbPath);
  const loaded = g2.getProject("s1")!;
  assert.equal(g2.getFact(loaded.id, f.id)!.status, "pending");
  g2.clearFactConditions(loaded.id, f.id);
  assert.equal(g2.getFact(loaded.id, f.id)!.status, "candidate");
  g2.resolveFact(loaded.id, f.id, { decision: "pass", reason: "condition satisfied", confidence: 0.7 });
  assert.equal(g2.getFact(loaded.id, f.id)!.status, "pass");
  g2.close();
});

test("SqliteGraph: metacog outbox commit is durable and idempotently publishable", () => {
  const dir = tempDir();
  const dbPath = join(dir, "outbox.db");
  const graph = new SqliteGraph(dbPath);
  const project = graph.createProject({
    session: "outbox", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  graph.commitMetacogResult(project.id, {
    hints: [],
    outputSummary: "0 hints",
    broadcast: {
      eventId: "fact:s:project:f001",
      scope: "group-a",
      kind: "fact",
      sourceFactId: "f001",
      summary: "durable finding",
      confidence: 0.9,
    },
  });
  assert.equal(graph.federationOutbox(project.id, "pending").length, 1);
  graph.close();

  const reopened = new SqliteGraph(dbPath);
  const loaded = reopened.getProject("outbox")!;
  assert.equal(reopened.federationOutbox(loaded.id, "pending").length, 1);
  reopened.markFederationOutboxPublished(
    loaded.id,
    "fact:s:project:f001",
    "fact:s:project:f001",
    42,
  );
  reopened.markFederationOutboxPublished(
    loaded.id,
    "fact:s:project:f001",
    "fact:s:project:f001",
    42,
  );
  assert.equal(reopened.federationOutbox(loaded.id, "pending").length, 0);
  assert.equal(reopened.federationOutbox(loaded.id, "published")[0]!.broadcastSeq, 42);
  reopened.close();
});


test("SqliteGraph: intent lifecycle (add → claim → conclude)", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, {
    description: "do x",
    creator: "planner",
    dispatchRequested: false,
  });
  assert.equal(intent.status, "open");
  assert.equal(intent.dispatchRequested, false);

  g.requestExplorerDispatch(p.id, intent.id);
  assert.equal(g.getIntent(p.id, intent.id)!.dispatchRequested, true);

  g.claimIntent(p.id, intent.id, "w1", 60000);
  assert.equal(g.getIntent(p.id, intent.id)!.status, "claimed");

  const fact = g.addFact(p.id, { description: "result", source: "explorer" });
  g.concludeIntent(p.id, intent.id, fact.id);
  assert.equal(g.getIntent(p.id, intent.id)!.status, "pass");
  g.close();
});

test("SqliteGraph: EndFact cannot bypass unfinished graph work", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, { description: "unfinished", creator: "planner" });
  assert.throws(() => g.createEndFact(p.id, "early", []), /intents are open or claimed/);
  g.failIntent(p.id, intent.id, "closed", false, "planner");
  const candidate = g.addFact(p.id, { description: "unreviewed", source: "explorer" });
  assert.throws(() => g.createEndFact(p.id, "early", []), /candidate facts await evaluation/);
  g.resolveFact(p.id, candidate.id, { decision: "deny", reason: "invalid" });
  assert.equal(g.createEndFact(p.id, "done", []).status, "active");
  g.close();
});

test("SqliteGraph: failIntent with killedBy", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, { description: "do x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 60000);
  g.failIntent(p.id, intent.id, "wrong direction", false, "planner");
  const failed = g.getIntent(p.id, intent.id);
  assert.equal(failed!.status, "deny");
  assert.equal(failed!.killedBy, "planner");
  g.close();
});

test("SqliteGraph: hint with kind and targetIntentId", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const h = g.addHint(p.id, {
    content: "stop this", creator: "metacog",
    kind: "stop-explorer", targetIntentId: intent.id,
  });
  assert.equal(h.kind, "stop-explorer");
  assert.equal(h.targetIntentId, intent.id);
  assert.equal(g.unconsumedHints(p.id).length, 1);
  g.consumeHint(p.id, h.id);
  assert.equal(g.unconsumedHints(p.id).length, 0);
  g.close();
});

test("SqliteGraph: persistence survives reopen", () => {
  const dir = tempDir();
  const dbPath = join(dir, "persist.db");
  const g1 = new SqliteGraph(dbPath);
  const p = g1.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  g1.addFact(p.id, { description: "persisted fact", source: "explorer", confidence: 0.9 });
  g1.close();

  const g2 = new SqliteGraph(dbPath);
  const loaded = g2.getProject("s1");
  assert.ok(loaded);
  const facts = g2.facts(loaded!.id);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].description, "persisted fact");
  g2.close();
});

test("SqliteGraph: intent_sets is the canonical ordered source store", () => {
  const dir = tempDir();
  const dbPath = join(dir, "intent-sets.db");
  const g1 = new SqliteGraph(dbPath);
  const p = g1.createProject({
    session: "sources", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const first = g1.addFact(p.id, { description: "first", source: "explorer" });
  const second = g1.addFact(p.id, { description: "second", source: "explorer" });
  g1.resolveFact(p.id, first.id, { decision: "pass", reason: "verified" });
  g1.resolveFact(p.id, second.id, { decision: "pass", reason: "verified" });
  const intent = g1.addIntent(p.id, {
    description: "combine", creator: "planner", parentFactIds: [second.id, first.id],
  });
  g1.close();

  const raw = new DatabaseSync(dbPath);
  assert.equal((raw.prepare("PRAGMA application_id").get() as { application_id: number }).application_id, 1346715981);
  assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  const intentColumns = raw.prepare("PRAGMA table_info(intents)").all()
    .map((row) => String((row as { name: string }).name));
  assert.equal(intentColumns.includes("parent_fact_ids_json"), false);
  assert.equal(intentColumns.includes("chain_json"), false);
  assert.equal(raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs'",
  ).get(), undefined);
  const removedTable = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'intent_sources'",
  ).get();
  assert.equal(removedTable, undefined);
  raw.close();

  const g2 = new SqliteGraph(dbPath);
  assert.deepEqual(g2.getIntent(p.id, intent.id)?.parentFactIds, [second.id, first.id]);
  g2.close();
});

test("SqliteGraph: rejects an existing database without the first-version identity", () => {
  const dbPath = join(tempDir(), "unmarked.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE unknown_state (id TEXT PRIMARY KEY)");
  db.close();
  assert.throws(() => new SqliteGraph(dbPath), /does not use the first-version schema/);
});

test("SqliteGraph: progress computes correctly", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  g.addFact(p.id, { description: "f1", source: "explorer" });
  g.addFact(p.id, { description: "f2", source: "explorer" });
  const pr = g.progress(p.id);
  assert.equal(pr.totalFacts, 2);
  assert.equal(pr.candidateFacts, 2);
  assert.equal(pr.pendingFacts, 0);
  assert.equal(pr.passFacts, 0);
  g.close();
});

test("SessionManager: open, list, delete", () => {
  const base = tempDir();
  const sm = new SessionManager(base);
  const g1 = sm.open("session-a");
  const g2 = sm.open("session-b");
  assert.ok(sm.info("session-a").exists);
  assert.ok(sm.info("session-b").exists);
  const sessions = sm.listSessions();
  assert.ok(sessions.includes("session-a"));
  assert.ok(sessions.includes("session-b"));
  // Close db handles BEFORE deleting their directories: on Windows rmSync fails
  // with EPERM while the SQLite file is still open.
  if (g1 instanceof SqliteGraph) g1.close();
  if (g2 instanceof SqliteGraph) g2.close();
  sm.delete("session-a");
  assert.ok(!sm.info("session-a").exists);
  assert.ok(sm.info("session-b").exists);
});

test("FederatedGraph: search facts across sessions", () => {
  const base = tempDir();
  const sm = new SessionManager(base);
  const fed = new FederatedGraph(sm);

  const g1 = sm.open("app-a") as SqliteGraph;
  const g2 = sm.open("app-b") as SqliteGraph;

  const p1 = g1.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g1.addFact(p1.id, { description: "WebView vulnerability in app-a", source: "explorer", confidence: 0.9 });

  const p2 = g2.createProject({
    session: "s2", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g2.addFact(p2.id, { description: "WebView bypass in app-b", source: "explorer", confidence: 0.8 });

  const allAccepted = fed.searchFactsAcrossSessions(["app-a", "app-b"], { status: "candidate" });
  assert.equal(allAccepted.length, 2);

  const webviewOnly = fed.searchFactsAcrossSessions(["app-a", "app-b"], { query: "WebView" });
  assert.equal(webviewOnly.length, 2);

  const appAOnly = fed.searchFactsAcrossSessions(["app-a", "app-b"], { query: "app-a" });
  assert.equal(appAOnly.length, 1);
  assert.equal(appAOnly[0].sessionId, "app-a");

  g1.close();
  g2.close();
});

test("FederatedGraph: search intents across sessions", () => {
  const base = tempDir();
  const sm = new SessionManager(base);
  const fed = new FederatedGraph(sm);

  const g1 = sm.open("sess-x") as SqliteGraph;
  const g2 = sm.open("sess-y") as SqliteGraph;

  const p1 = g1.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  const source = g1.addFact(p1.id, { description: "crypto is reachable", source: "explorer" });
  g1.resolveFact(p1.id, source.id, { decision: "pass", reason: "verified" });
  g1.addIntent(p1.id, {
    description: "analyze crypto module", creator: "planner", parentFactIds: [source.id],
  });

  const p2 = g2.createProject({
    session: "s2", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g2.addIntent(p2.id, { description: "analyze network module", creator: "planner" });

  const results = fed.searchIntentsAcrossSessions(["sess-x", "sess-y"], "crypto");
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "sess-x");
  assert.equal(results[0].intent.description, "analyze crypto module");
  assert.deepEqual(results[0].intent.parentFactIds, [source.id]);

  g1.close();
  g2.close();
});
