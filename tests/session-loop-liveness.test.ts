import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { agentRecords, minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = []) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun: null });
}

test("dispatch: an open Intent without planner dispatch request does not start an explorer", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, {
    description: "held work",
    creator: "planner",
    dispatchRequested: false,
  });

  const loop = new SessionLoop(graph, worker, minimalConfig());
  await loop.step(p.id);

  assert.equal(graph.getIntent(p.id, intent.id)!.status, "open");
  assert.equal((await agentRecords(p)).length, 0);
});

test("session cardinality: SessionLoop rejects multiple tasks in one session-local Graph", () => {
  const graph = new TestGraph();
  createProject(graph, { session: "s1" });
  createProject(graph, { session: "s2" });
  assert.throws(
    () => new SessionLoop(graph, new MockWorker(), minimalConfig()),
    /exactly one task\/Project per session/,
  );
});

test("liveness: repeated planner failures fail the project instead of completing it", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  worker.register(/automated planning module/i, "not json");

  const loop = new SessionLoop(graph, worker, minimalConfig());
  const result = await loop.run(p.id, { idlePollMs: 1 });

  assert.equal(result.type, "failed");
  assert.equal(graph.getProject(p.id)!.status, "failed");
  assert.equal(graph.events(p.id).filter((e) => e.type === "planner.error").length, 3);
  assert.ok(graph.events(p.id).some((e) => e.type === "project.failed_retry_exhausted"));
});

test("liveness: profile retry.maxAttempts controls the durable failure threshold", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  worker.register(/automated planning module/i, "not json");
  const config = minimalConfig();
  config.profiles.planner.retry = { maxAttempts: 1 };

  const result = await new SessionLoop(graph, worker, config).step(p.id);

  assert.equal(result.type, "failed");
  assert.equal(graph.events(p.id).filter((event) => event.type === "planner.error").length, 1);
});

test("liveness: planner retry.backoffMs is reconstructed from event timestamps", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  worker.register(/automated planning module/i, "not json");
  const config = minimalConfig();
  config.profiles.planner.retry = { maxAttempts: 2, backoffMs: 80 };
  const first = new SessionLoop(graph, worker, config);
  await first.step(p.id);

  const resumed = new SessionLoop(graph, worker, config);
  const deferred = await resumed.step(p.id);
  assert.equal(deferred.type, "idle");
  assert.equal(worker.calls().length, 1, "restart must preserve the retry delay");

  await new Promise((resolve) => setTimeout(resolve, 90));
  const exhausted = await resumed.step(p.id);
  assert.equal(exhausted.type, "failed");
  assert.equal(worker.calls().length, 2);
});

test("recovery: planner retry count is rebuilt from events after runtime restart", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  worker.register(/automated planning module/i, "not json");

  const firstRuntime = new SessionLoop(graph, worker, minimalConfig());
  await firstRuntime.step(p.id);
  await firstRuntime.step(p.id);
  assert.equal(graph.getProject(p.id)!.status, "active");

  const resumedRuntime = new SessionLoop(graph, worker, minimalConfig());
  const result = await resumedRuntime.step(p.id);

  assert.equal(result.type, "failed");
  assert.equal(graph.events(p.id).filter((event) => event.type === "planner.error").length, 3);
});

test("recovery: unresolved evaluator verdict is replayed into the resumed planner prompt", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  const fact = graph.addFact(p.id, {
    description: "persisted accepted evidence",
    source: "explorer",
  });
  graph.resolveFact(p.id, fact.id, { decision: "pass", reason: "persisted verdict" });
  worker.register(/automated planning module/i, (request) => {
    assert.match(request.prompt, /Recent Evaluator Verdicts/);
    assert.match(request.prompt, /persisted verdict/);
    return env("decisions", {
      createIntents: [],
      failIntents: [],
      consumeHints: [],
      concludeRun: { description: "done", from: [fact.id] },
    });
  });

  const resumedRuntime = new SessionLoop(graph, worker, minimalConfig());
  const result = await resumedRuntime.step(p.id);

  assert.equal(result.type, "completed");
});

test("liveness: repeated evaluator failures fail explicitly and keep the candidate pending", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  let planned = false;
  worker.register(/automated planning module/i, () => {
    if (planned) return decisions();
    planned = true;
    return decisions([{ description: "EVALUATE-ME" }]);
  });
  worker.register(/EVALUATE-ME/i, env("fact", { description: "candidate", confidence: 0.8 }));
  worker.register(/Evaluator Role/i, "not json");

  const loop = new SessionLoop(graph, worker, minimalConfig());
  const result = await loop.run(p.id, { idlePollMs: 1 });

  assert.equal(result.type, "failed");
  assert.equal(graph.getProject(p.id)!.status, "failed");
  assert.equal(graph.candidateFacts(p.id).length, 1, "transient evaluator errors must not deny the fact");
  assert.equal(graph.events(p.id).filter((e) => e.type === "evaluator.error").length, 3);
});

test("recovery: another runtime preserves an unexpired claimed Intent", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "orphan", creator: "planner" });
  graph.claimIntent(p.id, intent.id, "old-worker", 300_000);
  new SessionLoop(graph, new MockWorker(), minimalConfig());

  assert.equal(graph.getIntent(p.id, intent.id)!.status, "claimed");
  graph.close();
});

test("recovery: an expired Intent claim is swept and requeued", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "expired", creator: "planner" });
  graph.claimIntent(p.id, intent.id, "old-worker", -1);
  new SessionLoop(graph, new MockWorker(), minimalConfig());

  assert.equal(graph.getIntent(p.id, intent.id)!.status, "open");
  graph.close();
});

test("fencing: a late explorer cannot commit after its intent was re-leased", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "fenced", creator: "planner" });
  const first = graph.claimIntent(p.id, intent.id, "worker-1", 300_000);
  const firstClaim = { workerId: "worker-1", epoch: first.leaseEpoch };
  graph.releaseIntent(p.id, intent.id, firstClaim);
  const second = graph.claimIntent(p.id, intent.id, "worker-2", 300_000);

  assert.ok(second.leaseEpoch > firstClaim.epoch);
  assert.throws(() => graph.commitExplorerResult(p.id, intent.id, {
    description: "late result",
    source: "explorer",
  }, firstClaim), /stale or expired intent lease/);
  assert.equal(graph.facts(p.id).length, 0);
  assert.equal(graph.getIntent(p.id, intent.id)!.lease?.workerId, "worker-2");
});

test("cancellation: stop interrupts an in-flight planner and returns stopped", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  worker.register(/automated planning module/i, () => {
    notifyStarted();
    return new Promise<string>(() => { /* cancelled by AbortSignal */ });
  });

  const loop = new SessionLoop(graph, worker, minimalConfig());
  const stepping = loop.step(p.id);
  await started;
  loop.addDirective(p.id, { kind: "stop", payload: "test stop" });
  const result = await stepping;

  assert.equal(result.type, "stopped");
  assert.equal(graph.getProject(p.id)!.status, "stopped");
  assert.equal((await agentRecords(p))[0]?.status, "cancelled");
});
