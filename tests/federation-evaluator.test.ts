import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { broadcastEvaluatorExtra } from "../dist/agent/subagent-runner.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

function attachMetacog(
  graph: TestGraph,
  worker: MockWorker,
  config: ReturnType<typeof minimalConfig>,
  loop: SessionLoop,
  bus: FederationBus,
  sessionId: string,
) {
  const metacog = new MetacogSupervisor(
    graph,
    worker,
    config,
    undefined,
    { sessionId, scope: "app-group" },
  );
  loop.setMetacog(metacog);
  return metacog;
}

test("broadcastEvaluatorExtra renders an untrusted broadcast and local pending facts", () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  const fact = graph.addFact(project.id, {
    description: "exported activity may lack permission",
    source: "explorer",
  });
  graph.resolveFact(project.id, fact.id, {
    decision: "pending",
    reason: "need manifest evidence",
    requiredConditions: ["manifest export"],
  });

  const prompt = broadcastEvaluatorExtra({
    id: "b1",
    kind: "fact",
    sourceSessionId: "manifest-session",
    sourceProjectId: "p1",
    sourceFactId: "f1",
    summary: "manifest confirms the activity is exported",
    confidence: 0.95,
  }, graph.facts(project.id, "pending"));

  assert.match(prompt, /FactBroadcast Under Review/);
  assert.match(prompt, /Broadcast kind: fact/);
  assert.match(prompt, /untrusted external reference/);
  assert.match(prompt, new RegExp(fact.id));
  assert.match(prompt, /broadcast_assessment/);
});

test("broadcastEvaluatorExtra distinguishes a final session summary from a Fact", () => {
  const prompt = broadcastEvaluatorExtra({
    id: "summary-1",
    kind: "session_summary",
    sourceSessionId: "manifest-session",
    sourceProjectId: "p1",
    summary: "manifest analysis finished",
    confidence: 1,
  }, []);
  assert.match(prompt, /Broadcast kind: session_summary/);
  assert.match(prompt, /not a Fact/);
  assert.match(prompt, /cannot satisfy a pending Fact condition/);
});

test("received broadcast creates a tracked evaluator run and advances the durable cursor", async () => {
  const bus = new TestFederationBus();
  bus.registerSession("source", "app-group");

  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.federation = { scope: "app-group" };
  const project = createProject(graph);
  const loop = new SessionLoop(graph, worker, config, {
    federationBus: bus,
    sessionId: "target",
    federationScope: "app-group",
  });

  worker.register(/automated planning module/i, decisions());
  worker.register(/Cross-session FactBroadcast Under Review/i, env("broadcast_assessment", {
    decision: "relevant",
    reason: "this affects the same app component",
  }));

  const insight = bus.publishInsight(
    "fact",
    { sessionId: "source", projectId: "source-project", factId: "f001" },
    "an exported activity accepts untrusted deep links",
    0.9,
    undefined,
    { id: "fact:source:f001", scope: "app-group" },
  );

  await loop.step(project.id);

  const event = graph.events(project.id).find(
    (item) => item.type === "federation.broadcast_assessed"
      && item.payload.broadcastId === insight.id,
  );
  assert.ok(event);
  assert.equal(event!.payload.decision, "relevant");
  assert.equal(event!.payload.broadcastKind, "fact");
  const runs = graph.subagentRuns(project.id, { profileId: "evaluator" });
  assert.ok(runs.some((run) => run.inputSummary?.includes(insight.id) && run.status === "completed"));
  assert.equal(graph.facts(project.id).length, 0, "external broadcast must not become a local Fact");
  assert.equal(bus.pendingForSession("target").length, 0);
  assert.equal(bus.cursor("target"), bus.headSeq("app-group"));
});

test("repeated broadcast evaluator failures fail the session instead of livelocking the group", async () => {
  const bus = new TestFederationBus();
  bus.registerSession("source", "app-group");
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.evaluator.retry = { maxAttempts: 2 };
  config.federation = { scope: "app-group" };
  const project = createProject(graph, { session: "poison-target" });
  const loop = new SessionLoop(graph, worker, config, {
    federationBus: bus,
    sessionId: "poison-target",
    federationScope: "app-group",
  });
  worker.register(/Cross-session FactBroadcast Under Review/i, "not a worker envelope");
  const insight = bus.publishInsight(
    "fact",
    { sessionId: "source", projectId: "source-project", factId: "poison" },
    "broadcast that repeatedly fails evaluation",
    0.8,
    undefined,
    { id: "fact:source:poison", scope: "app-group" },
  );

  await loop.step(project.id);
  assert.equal(graph.getProject(project.id)?.status, "active");
  const result = await loop.step(project.id);
  assert.equal(result.type, "failed");
  assert.equal(graph.getProject(project.id)?.status, "failed");
  assert.equal(bus.pendingForSession("poison-target")[0]?.id, insight.id);
  assert.ok(graph.events(project.id).some((event) =>
    event.type === "project.failed_retry_exhausted"
      && event.payload.stage === "broadcast-evaluator"));
});

test("condition_satisfied may only reactivate an existing local pending Fact", async () => {
  const bus = new TestFederationBus();
  bus.registerSession("source", "app-group");
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.federation = { scope: "app-group" };
  const project = createProject(graph);
  const pending = graph.addFact(project.id, {
    description: "deep-link handler may be reachable externally",
    source: "explorer",
  });
  graph.resolveFact(project.id, pending.id, {
    decision: "pending",
    reason: "need exported component evidence",
    requiredConditions: ["exported activity"],
  });

  const loop = new SessionLoop(graph, worker, config, {
    federationBus: bus,
    sessionId: "target",
    federationScope: "app-group",
  });
  worker.register(/automated planning module/i, decisions());
  worker.register(/Candidate Fact Under Review/i, env("verdict", {
    decision: "pass",
    reason: "broadcast supplied the missing prerequisite",
  }));
  worker.register(/Cross-session FactBroadcast Under Review/i, env("broadcast_assessment", {
    decision: "condition_satisfied",
    reason: "the manifest session verified export",
    targetFactId: pending.id,
  }));

  bus.publishInsight(
    "fact",
    { sessionId: "source", projectId: "source-project", factId: "f002" },
    "the deep-link activity is exported",
    0.95,
    undefined,
    { id: "fact:source:f002", scope: "app-group" },
  );

  await loop.step(project.id);
  assert.equal(graph.getFact(project.id, pending.id)?.status, "pass");
  assert.ok(graph.events(project.id).some((event) => event.type === "fact.reactivated"));
});

test("accepted Fact is broadcast only after metacog and consumed by the sibling evaluator", async () => {
  const bus = new TestFederationBus();

  const graphA = new TestGraph();
  const workerA = new MockWorker();
  const configA = minimalConfig();
  configA.federation = { scope: "app-group" };
  const projectA = createProject(graphA, { session: "manifest" });
  const loopA = new SessionLoop(graphA, workerA, configA, {
    federationBus: bus,
    sessionId: "manifest",
    federationScope: "app-group",
  });
  attachMetacog(graphA, workerA, configA, loopA, bus, "manifest");

  workerA.register(/automated planning module/i, decisions([{ description: "CHECK-MANIFEST" }]));
  workerA.register(/CHECK-MANIFEST/i, env("fact", {
    description: "MainActivity is exported without a signature permission",
    evidence: ["AndroidManifest.xml:12"],
    confidence: 0.95,
  }));
  workerA.register(/Candidate Fact Under Review/i, env("verdict", {
    decision: "pass",
    reason: "manifest evidence is direct",
  }));
  workerA.register(/# Metacog Role/i, env("hints", { hints: [] }));

  await loopA.step(projectA.id);
  const published = bus.recentInsights(10, "app-group");
  assert.equal(published.length, 1);
  assert.equal(published[0]!.source.sessionId, "manifest");
  assert.ok(graphA.events(projectA.id).some((event) => event.type === "metacog.fact_reviewed"));

  const graphB = new TestGraph();
  const workerB = new MockWorker();
  const configB = minimalConfig();
  configB.federation = { scope: "app-group" };
  const projectB = createProject(graphB, { session: "deeplink" });
  const loopB = new SessionLoop(graphB, workerB, configB, {
    federationBus: bus,
    sessionId: "deeplink",
    federationScope: "app-group",
  });
  workerB.register(/automated planning module/i, decisions());
  workerB.register(/Cross-session FactBroadcast Under Review/i, env("broadcast_assessment", {
    decision: "relevant",
    reason: "export status is required for deep-link reachability",
  }));

  await loopB.step(projectB.id);
  assert.ok(graphB.events(projectB.id).some(
    (event) => event.type === "federation.broadcast_assessed"
      && event.payload.broadcastId === published[0]!.id,
  ));
  assert.equal(graphB.facts(projectB.id).length, 0);
});
