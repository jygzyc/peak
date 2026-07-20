import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { roleLogs, minimalConfig, createProject, env } from "./helper.ts";

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
  assert.equal((await roleLogs(p)).length, 0);
});

test("session cardinality: analysis.db rejects a second task for the same Session UUID", () => {
  const graph = new TestGraph();
  createProject(graph, { session: "s1" });
  assert.throws(
    () => createProject(graph, { session: "s2" }),
    /UNIQUE constraint failed: projects\.session_id/,
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
  assert.equal(worker.calls().length, 3);
});

test("liveness: profile retry.maxAttempts controls the runtime failure threshold", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  worker.register(/automated planning module/i, "not json");
  const config = minimalConfig();
  config.profiles.planner.retry = { maxAttempts: 1 };

  const result = await new SessionLoop(graph, worker, config).step(p.id);

  assert.equal(result.type, "failed");
  assert.equal(worker.calls().length, 1);
});

test("liveness: planner retry.backoffMs is process-local", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  worker.register(/automated planning module/i, "not json");
  const config = minimalConfig();
  config.profiles.planner.retry = { maxAttempts: 2, backoffMs: 80 };
  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  await loop.step(p.id);
  assert.equal(worker.calls().length, 1, "backoff must suppress another live retry");

  await new Promise((resolve) => setTimeout(resolve, 90));
  const exhausted = await loop.step(p.id);
  assert.equal(exhausted.type, "failed");
  assert.equal(worker.calls().length, 2);
});

test("recovery: persisted Fact state is visible to a resumed planner", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  const fact = graph.addFact(p.id, {
    description: "persisted accepted evidence",
    source: "explorer",
  });
  graph.resolveFact(p.id, fact.id, { decision: "pass", reason: "persisted verdict" });
  const resumedRuntime = new SessionLoop(graph, worker, minimalConfig());
  assert.equal(resumedRuntime.projectStatus(p.id), "active");
  assert.equal(graph.getFact(p.id, fact.id)?.status, "pass");
  assert.equal(graph.getFact(p.id, fact.id)?.reviewerReason, "persisted verdict");
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
  assert.equal(worker.calls().filter((call) => call.prompt.includes("# Evaluator Role")).length, 3);
});

test("recovery: a new runtime reopens orphaned claimed Intents", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "orphan", creator: "planner" });
  graph.claimIntent(p.id, intent.id);
  new SessionLoop(graph, new MockWorker(), minimalConfig());

  assert.equal(graph.getIntent(p.id, intent.id)!.status, "open");
  graph.close();
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
  assert.deepEqual((await roleLogs(p)).map((entry) => entry.kind), ["context"]);
});
