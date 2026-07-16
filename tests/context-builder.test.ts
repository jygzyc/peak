import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { renderGraphView } from "../dist/agent/graph-view.js";
import {
  materializeGraphContext,
  renderGraphContextArtifact,
} from "../dist/agent/context-builder.js";
import { buildDynamicContext, ServerSessionGraphReader } from "../dist/server/session-graph-reader.js";
import { TestGraph } from "./test-graph.ts";
import { createProject } from "./helper.ts";

function fact(id: string, desc: string, evidence: string[] = []) {
  return {
    id, projectId: "p", description: desc, evidence,
    source: "explorer", confidence: 0.9, status: "pass" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("graph-view: full renders accepted facts + rejected + intents", () => {
  const text = renderGraphView({
    passFacts: [fact("f001", "first")],
    denyFacts: [fact("f002", "dead")],
    openIntents: [{ id: "i001", projectId: "p", description: "task", creator: "planner", parentFactIds: [], status: "open" as const, priority: 0, createdAt: "" }],
  }, { view: "full" });
  assert.match(text, /Passed Facts/);
  assert.match(text, /f001/);
  assert.match(text, /Denied/);
  assert.match(text, /Current Intents/);
});

test("graph-view: focused renders context + dead-ends only", () => {
  const text = renderGraphView({
    passFacts: [fact("f001", "ctx")],
    denyFacts: [fact("f002", "dead")],
  }, { view: "focused" });
  assert.match(text, /Context/);
  assert.match(text, /Dead-Ends/);
  assert.doesNotMatch(text, /Accepted Facts/);
});

test("graph-view: evidence-only filters out facts without evidence", () => {
  const text = renderGraphView({
    passFacts: [
      fact("f001", "with evidence", ["proof"]),
      fact("f002", "no evidence"),
    ],
  }, { view: "evidence-only" });
  assert.match(text, /f001/);
  assert.doesNotMatch(text, /f002/);
});

test("graph-view: summary shows counts not bodies", () => {
  const text = renderGraphView({
    passFacts: [fact("f001", "secret")],
    denyFacts: [],
    progress: {
      totalFacts: 1, passFacts: 1, candidateFacts: 0, pendingFacts: 0, denyFacts: 0,
      openIntents: 0, claimedIntents: 0,
      stepsExecuted: 5, lastActivityAt: "", stagnationLevel: 0,
    },
  }, { view: "summary", includeProgress: true });
  assert.match(text, /Progress/);
  assert.match(text, /Passed facts: 1/);
  assert.doesNotMatch(text, /secret/);
});

test("graph-view: every policy preserves the task Objective", () => {
  for (const view of ["full", "focused", "evidence-only", "summary"] as const) {
    const text = renderGraphView({
      target: "workspace/app",
      goal: "prove the requested property",
      passFacts: [],
    }, { view });
    assert.match(text, /## Objective/);
    assert.match(text, /workspace\/app/);
    assert.match(text, /prove the requested property/);
  }
});

test("graph-view: maxFacts caps rendered fact count", () => {
  const facts = [];
  for (let i = 1; i <= 10; i++) facts.push(fact(`f${i}`, `fact ${i}`));
  const text = renderGraphView({ passFacts: facts }, { view: "full", maxFacts: 3 });
  assert.doesNotMatch(text, /fact 1\b/);
  assert.match(text, /fact 8/);
  assert.match(text, /fact 9/);
  assert.match(text, /fact 10/);
});

test("context-builder: buildDynamicContext reads from graph", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const fact = graph.addFact(p.id, { description: "discovered fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, fact.id, { decision: "pass", reason: "ok" });
  const text = buildDynamicContext({
    projectId: p.id, graph,
    spec: { graphView: "full", includeProgress: true },
  });
  assert.match(text, /discovered fact/);
});

test("context-builder: relevanceScope=linked filters to linked facts only", () => {
  const graph = new TestGraph();
  const p = createProject(graph);

  const f1 = graph.addFact(p.id, { description: "root fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f1.id, { decision: "pass", reason: "ok" });
  const f2 = graph.addFact(p.id, { description: "linked fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f2.id, { decision: "pass", reason: "ok" });
  const f3 = graph.addFact(p.id, { description: "unrelated fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f3.id, { decision: "pass", reason: "ok" });

  // Link f1 → f2 via a concluded intent (an Intent IS the graph edge).
  const linkIntent = graph.addIntent(p.id, { description: "derive f2 from f1", creator: "planner", parentFactIds: [f1.id] });
  graph.claimIntent(p.id, linkIntent.id, "w1", 30000);
  graph.concludeIntent(p.id, linkIntent.id, f2.id);

  // A separate intent the explorer is working on, rooted at f1.
  const intent = graph.addIntent(p.id, { description: "investigate", creator: "planner", parentFactIds: [f1.id] });

  const text = buildDynamicContext({
    projectId: p.id, graph,
    spec: { graphView: "focused", relevanceScope: "linked" },
    intent,
  });

  assert.match(text, /root fact/, "root fact should be included");
  assert.match(text, /linked fact/, "linked fact should be included via intent-edge traversal");
  assert.doesNotMatch(text, /unrelated fact/, "unrelated fact should be filtered out");
});

test("context-builder: relevanceScope=all includes everything (default)", () => {
  const graph = new TestGraph();
  const p = createProject(graph);

  const f1 = graph.addFact(p.id, { description: "fact A", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f1.id, { decision: "pass", reason: "ok" });
  const f2 = graph.addFact(p.id, { description: "fact B", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f2.id, { decision: "pass", reason: "ok" });

  const text = buildDynamicContext({
    projectId: p.id, graph,
    spec: { graphView: "focused", relevanceScope: "all" },
  });

  assert.match(text, /fact A/);
  assert.match(text, /fact B/);
});

test("context-builder: snapshot and artifact are deterministic and auditable", async () => {
  const graph = new TestGraph();
  const p = createProject(graph, { session: "artifact-session" });
  const fact = graph.addFact(p.id, { description: "artifact fact", source: "explorer" });
  graph.resolveFact(p.id, fact.id, { decision: "pass", reason: "verified" });
  const reader = new ServerSessionGraphReader(graph);

  const first = await reader.readSnapshot({
    sessionId: p.session,
    profileId: "planner",
    projectId: p.id,
    spec: { graphView: "full" },
  });
  const second = await reader.readSnapshot({
    sessionId: p.session,
    profileId: "planner",
    projectId: p.id,
    spec: { graphView: "full" },
  });
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.graphSeq, second.graphSeq);

  const artifact = await materializeGraphContext(p.sessionDir, "agent_context_1", first);
  const stored = JSON.parse(readFileSync(artifact.resolvedPath, "utf8"));
  assert.deepEqual(stored, first);
  assert.notEqual(artifact.sha256, first.contentHash);
  assert.equal(artifact.relativePath, "agents/agent_context_1/context.json");

  const injected = renderGraphContextArtifact(first, artifact);
  assert.match(injected, /Read the referenced JSON file/);
  assert.match(injected, /Never open analysis\.db/);
  assert.doesNotMatch(injected, /artifact fact/);
  await assert.rejects(
    materializeGraphContext(p.sessionDir, "../escape", first),
    /invalid agent id/,
  );
});
