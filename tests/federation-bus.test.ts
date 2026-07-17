import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { TestFederationBus } from "./test-graph.ts";

test("FederationBus: rejects an existing database without the first-version identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-fed-identity-"));
  const dbPath = join(dir, "unmarked.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE unknown_state (id TEXT PRIMARY KEY)");
  db.close();
  assert.throws(() => new FederationBus({ dbPath }), /does not use the first-version schema/);
  rmSync(dir, { recursive: true, force: true });
});

test("FederationBus: publishInsight + subscribeInsights receives summary", () => {
  const bus = new TestFederationBus();
  const received: string[] = [];
  bus.subscribeInsights((insight) => received.push(insight.summary));

  bus.publishInsight(
    "fact",
    { sessionId: "s1", projectId: "p1", factId: "f001" },
    "found auth bypass", 0.9,
  );

  assert.equal(received.length, 1);
  assert.equal(received[0], "found auth bypass");
});

test("FederationBus: insightsForSession excludes own session", () => {
  const bus = new TestFederationBus();
  bus.registerSession("s1", "group-a");
  bus.registerSession("s2", "group-a");
  bus.publishInsight("fact", { sessionId: "s1", projectId: "p1", factId: "f001" }, "from s1", 0.9);
  bus.publishInsight("fact", { sessionId: "s2", projectId: "p2", factId: "f002" }, "from s2", 0.9);

  const forS1 = bus.insightsForSession("s1");
  assert.equal(forS1.length, 1);
  assert.equal(forS1[0].source.sessionId, "s2");
});

test("FederationBus: source cursor advances while receivers wait for delivery", () => {
  const bus = new TestFederationBus();
  bus.registerSession("source", "group-a");
  bus.registerSession("target", "group-a");
  const insight = bus.publishInsight(
    "fact",
    { sessionId: "source", projectId: "p1", factId: "f1" },
    "verified fact",
    0.9,
    undefined,
    { id: "fact:source:p1:f1", scope: "group-a" },
  );

  assert.equal(bus.cursor("source"), insight.seq);
  assert.equal(bus.cursor("target"), insight.seq - 1);
  assert.equal(bus.allCursorsAtHead("group-a"), false);

  bus.acknowledge("target", insight.id, "evaluated", "run-1");
  assert.equal(bus.cursor("target"), insight.seq);
  assert.equal(bus.allCursorsAtHead("group-a"), true);
});

test("FederationBus: scope completion is atomic with durable broadcast quiescence", () => {
  const bus = new TestFederationBus();
  bus.registerSession("source", "group-a", "p1");
  bus.registerSession("target", "group-a", "p2");
  const insight = bus.publishInsight(
    "fact",
    { sessionId: "source", projectId: "p1", factId: "f1" },
    "verified fact",
    0.9,
    undefined,
    { id: "fact:source:p1:f1", scope: "group-a" },
  );
  bus.setSessionFinishReady("source", "p1", true);
  bus.setSessionFinishReady("target", "p2", true);
  assert.equal(bus.tryCompleteScope("group-a"), false, "pending delivery blocks completion");

  bus.acknowledge("target", insight.id, "evaluated", "run-1");
  assert.equal(bus.tryCompleteScope("group-a"), true);
  assert.ok(bus.registeredSessions("group-a").every((session) => session.completed));

  assert.throws(
    () => bus.publishInsight(
      "fact",
      { sessionId: "source", projectId: "p1", factId: "f2" },
      "late fact",
      0.8,
      undefined,
      { id: "fact:source:p1:f2", scope: "group-a" },
    ),
    /scope is already completed/,
  );
  assert.equal(
    bus.publishInsight(
      "fact",
      { sessionId: "source", projectId: "p1", factId: "f1" },
      "verified fact",
      0.9,
      undefined,
      { id: "fact:source:p1:f1", scope: "group-a" },
    ).id,
    insight.id,
    "idempotent insight replay remains valid after completion",
  );
});

test("FederationBus: an expected member blocks completion before its runtime registers", () => {
  const bus = new TestFederationBus();
  bus.registerExpectedSessions("declared", ["a", "b"]);
  bus.registerSession("a", "declared", "pa");
  bus.setSessionFinishReady("a", "pa", true);

  assert.equal(bus.tryCompleteScope("declared", bus.groupGeneration("declared")), false);
  assert.equal(bus.registeredSessions("declared").find((member) => member.sessionId === "b")?.memberStatus, "expected");
});

test("FederationBus: adding a dynamic member invalidates the previous generation", () => {
  const bus = new TestFederationBus();
  bus.registerSession("a", "dynamic", "pa");
  bus.setSessionFinishReady("a", "pa", true);
  const firstGeneration = bus.groupGeneration("dynamic")!;

  bus.registerSession("b", "dynamic", "pb");
  const secondGeneration = bus.groupGeneration("dynamic")!;

  assert.ok(secondGeneration > firstGeneration);
  assert.equal(bus.tryCompleteScope("dynamic", firstGeneration), false);
  assert.equal(bus.registeredSessions("dynamic").find((member) => member.sessionId === "a")?.finishReady, false);
});

test("FederationBus: unregister preserves a blocking terminal member instead of shrinking the group", () => {
  const bus = new TestFederationBus();
  bus.registerExpectedSessions("durable-members", ["a", "b"]);
  bus.registerSession("a", "durable-members", "pa");
  bus.registerSession("b", "durable-members", "pb");
  bus.setSessionFinishReady("a", "pa", true);
  bus.setSessionFinishReady("b", "pb", true);
  const beforeClose = bus.groupGeneration("durable-members")!;

  bus.unregisterSession("b");

  const afterClose = bus.groupGeneration("durable-members")!;
  assert.ok(afterClose > beforeClose);
  const closedMember = bus.registeredSessions("durable-members").find((member) => member.sessionId === "b");
  assert.equal(closedMember?.memberStatus, "left");
  assert.equal(closedMember?.projectId, "pb", "membership history retains the session-local project ref");
  assert.equal(bus.tryCompleteScope("durable-members", beforeClose), false);
  assert.equal(bus.tryCompleteScope("durable-members", afterClose), false);

  bus.registerSession("b", "durable-members", "pb");
  const resumedGeneration = bus.groupGeneration("durable-members")!;
  bus.setSessionFinishReady("a", "pa", true);
  bus.setSessionFinishReady("b", "pb", true);
  assert.equal(bus.tryCompleteScope("durable-members", resumedGeneration), true);
  bus.unregisterSession("a");
  const completedMember = bus.registeredSessions("durable-members").find((member) => member.sessionId === "a");
  assert.equal(completedMember?.memberStatus, "completed");
  assert.equal(completedMember?.completed, true);
  assert.equal(completedMember?.projectId, "pa");
});

test("FederationBus: conflicting declared member sets are rejected", () => {
  const bus = new TestFederationBus();
  bus.registerExpectedSessions("fixed", ["a", "b"]);
  assert.throws(
    () => bus.registerExpectedSessions("fixed", ["a", "c"]),
    /membership mismatch/,
  );
  assert.deepEqual(bus.registeredSessions("fixed").map((member) => member.sessionId), ["a", "b"]);
});

test("FederationBus: scopes are isolated", () => {
  const bus = new TestFederationBus();
  bus.registerSession("a", "scope-a");
  bus.registerSession("b", "scope-b");
  bus.publishInsight(
    "fact",
    { sessionId: "a", projectId: "p1", factId: "f1" },
    "scope-a only",
    0.9,
  );
  assert.equal(bus.pendingForSession("b").length, 0);
  assert.equal(bus.insightsForSession("b").length, 0);
});

test("FederationBus: moving a session resets cursor and finish readiness", () => {
  const bus = new TestFederationBus();
  bus.registerSession("a", "old", "pa");
  bus.registerSession("b", "old", "pb");
  bus.publishInsight(
    "fact",
    { sessionId: "a", projectId: "pa", factId: "f1" },
    "old-scope fact",
    0.9,
    undefined,
    { id: "old:a:f1", scope: "old" },
  );
  bus.setSessionFinishReady("b", "pb", true);
  assert.equal(bus.pendingForSession("b").length, 1);

  bus.registerSession("b", "new", "pb");

  assert.equal(bus.pendingForSession("b").length, 0);
  assert.equal(bus.cursor("b"), 0);
  assert.equal(bus.allSessionsFinishReady("new"), false);
});

test("FederationBus: recentInsights caps at limit", () => {
  const bus = new TestFederationBus();
  for (let i = 0; i < 10; i++) {
    bus.publishInsight("fact", { sessionId: "s1", projectId: "p1", factId: `f${i}` }, `insight ${i}`, 0.5);
  }
  assert.equal(bus.recentInsights(3).length, 3);
  assert.match(bus.recentInsights(1)[0]!.summary, /insight 9/);
});

test("FederationBus: unsubscribe stops receiving", () => {
  const bus = new TestFederationBus();
  const received: string[] = [];
  const unsub = bus.subscribeInsights((i) => received.push(i.summary));
  bus.publishInsight("fact", { sessionId: "s1", projectId: "p1", factId: "f1" }, "first", 0.5);
  unsub();
  bus.publishInsight("fact", { sessionId: "s1", projectId: "p1", factId: "f2" }, "second", 0.5);
  assert.equal(received.length, 1);
});

test("FederationBus: insights, deliveries, cursors, and finish readiness survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-federation-"));
  const dbPath = join(dir, "federation.db");
  const first = new FederationBus({ dbPath });
  first.registerExpectedSessions("group-persist", ["a", "b"]);
  first.registerSession("a", "group-persist", "pa");
  first.registerSession("b", "group-persist", "pb");
  const insight = first.publishInsight(
    "fact",
    { sessionId: "a", projectId: "pa", factId: "f1" },
    "persistent finding",
    0.9,
    undefined,
    { id: "fact:a:pa:f1", scope: "group-persist" },
  );
  first.setSessionFinishReady("a", "pa", true);
  first.setSessionFinishReady("b", "pb", true);
  first.close();

  const reopened = new FederationBus({ dbPath });
  assert.equal(reopened.groupGeneration("group-persist"), 1);
  assert.equal(reopened.taskGroup("group-persist")?.status, "running");
  assert.equal(reopened.pendingForSession("b").length, 1);
  assert.equal(reopened.pendingForSession("b")[0]!.id, insight.id);
  assert.equal(reopened.allSessionsFinishReady("group-persist"), true);
  assert.equal(reopened.allCursorsAtHead("group-persist"), false);
  const duplicate = reopened.publishInsight(
    "fact",
    { sessionId: "a", projectId: "pa", factId: "f1" },
    "persistent finding",
    0.9,
    undefined,
    { id: "fact:a:pa:f1", scope: "group-persist" },
  );
  assert.equal(duplicate.seq, insight.seq);
  assert.equal(reopened.recentInsights(10, "group-persist").length, 1);
  reopened.acknowledge("b", insight.id, "evaluated", "run-b");
  assert.equal(reopened.allCursorsAtHead("group-persist"), true);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});
