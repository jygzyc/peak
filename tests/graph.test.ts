import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { createProject } from "./helper.ts";

test("createProject starts with zero facts", () => {
  const g = new TestGraph();
  const p = createProject(g);
  assert.equal(g.facts(p.id).length, 0);
});

test("addIntent starts as open", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const i = g.addIntent(p.id, { description: "do x", creator: "planner" });
  assert.equal(i.id, "i001");
  assert.equal(i.status, "open");
});

test("an open Intent can be held until planner explicitly requests explorer dispatch", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, {
    description: "wait for planner",
    creator: "planner",
    dispatchRequested: false,
  });
  assert.equal(intent.status, "open");
  assert.equal(intent.dispatchRequested, false);
  g.requestExplorerDispatch(p.id, intent.id);
  assert.equal(g.getIntent(p.id, intent.id)!.dispatchRequested, true);
});

test("createEndFact rejects unfinished Intent and unevaluated candidate Fact", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "unfinished", creator: "planner" });
  assert.throws(
    () => g.createEndFact(p.id, "too early", []),
    /intents are open or claimed/,
  );
  g.failIntent(p.id, intent.id, "planner closed the route", false, "planner");
  const candidate = g.addFact(p.id, { description: "unreviewed", source: "explorer" });
  assert.throws(
    () => g.createEndFact(p.id, "still too early", []),
    /candidate facts await evaluation/,
  );
  g.resolveFact(p.id, candidate.id, { decision: "deny", reason: "invalid" });
  assert.equal(g.createEndFact(p.id, "review complete", []).status, "active");
});

test("claimIntent transitions open → claimed", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const claimed = g.claimIntent(p.id, intent.id);
  assert.equal(claimed.status, "claimed");
});

test("failIntent records killedBy", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id);
  g.failIntent(p.id, intent.id, "wrong direction", false, "planner");
  const failed = g.getIntent(p.id, intent.id);
  assert.equal(failed!.status, "deny");
  assert.equal(failed!.killedBy, "planner");
});

test("failIntent with recordDeadEnd=false does not record dead-end", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "Investigate X", creator: "planner" });
  g.claimIntent(p.id, intent.id);
  g.failIntent(p.id, intent.id, "transient", false);
  assert.ok(!g.isDeadEnd(p.id, "investigate x"));
});

test("hint defaults to kind=direction", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const h = g.addHint(p.id, { content: "try X", creator: "metacog" });
  assert.equal(h.kind, "direction");
  assert.equal(h.targetIntentId, undefined);
});

test("hint can carry stop-explorer kind + targetIntentId", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const h = g.addHint(p.id, { content: "stop this", creator: "metacog", kind: "stop-explorer", targetIntentId: intent.id });
  assert.equal(h.kind, "stop-explorer");
  assert.equal(h.targetIntentId, intent.id);
});

test("Intent stores task state without runtime ownership", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const claimed = g.claimIntent(p.id, intent.id);
  assert.equal(claimed.status, "claimed");
  assert.equal("lease" in claimed, false);
  assert.equal("leaseEpoch" in claimed, false);
});

test("directive queue filters by consumedAt", () => {
  const g = new TestGraph();
  const p = createProject(g);
  g.addDirective(p.id, { kind: "stop", payload: "done" });
  g.addDirective(p.id, { kind: "hint", payload: "try X" });
  assert.equal(g.unconsumedDirectives(p.id).length, 2);
  const dirs = g.unconsumedDirectives(p.id);
  g.consumeDirective(p.id, dirs[0].id);
  assert.equal(g.unconsumedDirectives(p.id).length, 1);
});

test("progress stagnation resets on fact accept", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id);
  g.failIntent(p.id, intent.id, "failed", false);
  assert.equal(g.progress(p.id).stagnationLevel, 1);
  const fact = g.addFact(p.id, { description: "good", source: "explorer" });
  assert.equal(fact.status, "candidate");
  g.resolveFact(p.id, fact.id, { decision: "pass", reason: "ok" });
  assert.equal(g.progress(p.id).stagnationLevel, 0);
});

test("deferred fact stays pending in graph, is low weight, and can be promoted later", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const f = g.addFact(p.id, { description: "reachable only after login", source: "explorer", confidence: 0.9 });

  g.resolveFact(p.id, f.id, {
    decision: "pending",
    reason: "missing auth precondition",
    requiredConditions: ["valid login session"],
  });

  const blocked = g.getFact(p.id, f.id)!;
  assert.equal(blocked.status, "pending");
  assert.notEqual(blocked.status, "blocked");
  assert.equal(blocked.confidence, 0.35);
  assert.deepEqual(blocked.requiredConditions, ["valid login session"]);
  assert.equal(g.progress(p.id).pendingFacts, 1);

  g.clearFactConditions(p.id, f.id);
  assert.equal(g.getFact(p.id, f.id)!.status, "candidate");
  g.resolveFact(p.id, f.id, { decision: "pass", reason: "precondition satisfied by another session", confidence: 0.75 });
  const accepted = g.getFact(p.id, f.id)!;
  assert.equal(accepted.status, "pass");
  assert.equal(accepted.confidence, 0.75);
});

test("resolveFact reject auto-records dead-end", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const f = g.addFact(p.id, { description: "SQL injection via login form", source: "explorer", confidence: 0.9 });

  g.resolveFact(p.id, f.id, { decision: "deny", reason: "not exploitable: parameterized query" });

  assert.equal(g.getFact(p.id, f.id)!.status, "deny");
  // The rejected fact's description should be auto-recorded as a dead-end route.
  assert.ok(g.isDeadEnd(p.id, "SQL injection via login form"), "reject should auto-record dead-end");
});

test("clearFactConditions reactivates a deferred pending fact", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const f = g.addFact(p.id, { description: "admin panel accessible", source: "explorer", confidence: 0.9 });
  g.resolveFact(p.id, f.id, { decision: "pending", reason: "needs auth", requiredConditions: ["admin token"] });

  // Before: deferred (pending + conditions), excluded from pendingCandidates
  assert.equal(g.candidateFacts(p.id).length, 0);

  g.clearFactConditions(p.id, f.id);
  // After: conditions cleared, candidate again for re-evaluation
  assert.equal(g.getFact(p.id, f.id)!.status, "candidate");
  assert.equal(g.getFact(p.id, f.id)!.requiredConditions?.length, 0);
  assert.equal(g.candidateFacts(p.id).length, 1);
});


test("addIntent rejects parentFactIds that are not verified (Cairn-minimal edge rule)", () => {
  const g = new TestGraph();
  const p = createProject(g);
  // A candidate fact — not verified yet.
  const f1 = g.addFact(p.id, { description: "candidate fact", source: "explorer" });
  assert.equal(f1.status, "candidate");
  assert.throws(
    () => g.addIntent(p.id, { description: "downstream", creator: "planner", parentFactIds: [f1.id] }),
    /not verified/,
  );
  // Empty parentFactIds is always allowed (fresh attack-surface collection).
  assert.doesNotThrow(() => g.addIntent(p.id, { description: "fresh", creator: "planner" }));
});

test("addIntent accepts parentFactIds that are verified", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const f1 = g.addFact(p.id, { description: "verified fact", source: "explorer" });
  g.resolveFact(p.id, f1.id, { decision: "pass", reason: "proven", confidence: 0.9 });
  assert.equal(g.facts(p.id, "pass").length, 1);
  const intent = g.addIntent(p.id, { description: "downstream", creator: "planner", parentFactIds: [f1.id] });
  assert.deepEqual(intent.parentFactIds, [f1.id]);
});

test("claimIntent on non-open intent throws", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  assert.throws(
    () => g.claimIntent(p.id, intent.id, "w2", 1000),
    /is not open/,
  );
});

test("concludeIntent on already-done intent throws", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.concludeIntent(p.id, intent.id, "f001");
  assert.throws(
    () => g.concludeIntent(p.id, intent.id, "f002"),
    /already concluded/,
  );
});

test("failIntent on already-failed intent throws", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.failIntent(p.id, intent.id, "first failure", false);
  assert.throws(
    () => g.failIntent(p.id, intent.id, "second failure", false),
    /already failed/,
  );
});

test("resolveFact on already-resolved fact throws", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const f = g.addFact(p.id, { description: "x", source: "explorer" });
  g.resolveFact(p.id, f.id, { decision: "pass", reason: "ok" });
  assert.throws(
    () => g.resolveFact(p.id, f.id, { decision: "deny", reason: "changed mind" }),
    /is not resolvable/,
  );
});

test("addFact sets stepDiscovered from current step counter", () => {
  const g = new TestGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.concludeIntent(p.id, intent.id);
  const fact = g.addFact(p.id, { description: "post-step fact", source: "explorer" });
  assert.ok(fact.stepDiscovered !== undefined, "stepDiscovered should be set");
  assert.ok(fact.stepDiscovered! >= 1, "stepDiscovered should reflect executed steps");
});
