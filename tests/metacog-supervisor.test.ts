import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { agentRecords, minimalConfig, createProject, env } from "./helper.ts";

function makeSupervisor(graph: TestGraph, worker: MockWorker, intervalMs = 50) {
  return new MetacogSupervisor(graph, worker, minimalConfig(), intervalMs);
}

function primeForMetacog(graph: TestGraph, p: ReturnType<typeof createProject>) {
  const f = graph.addFact(p.id, { description: "accepted fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f.id, { decision: "pass", reason: "ok" });
  return f;
}

test("metacog-supervisor: start sets running=true, stop sets running=false", () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const sup = makeSupervisor(graph, worker);
  assert.equal(sup.isRunning, false);
  sup.start();
  assert.equal(sup.isRunning, true);
  sup.stop();
  assert.equal(sup.isRunning, false);
});

test("metacog-supervisor: double start is idempotent", () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const sup = makeSupervisor(graph, worker);
  sup.start();
  sup.start();
  assert.equal(sup.isRunning, true);
  sup.stop();
});

test("metacog-supervisor: stop without start is safe", () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const sup = makeSupervisor(graph, worker);
  assert.doesNotThrow(() => sup.stop());
});

test("metacog-supervisor: runOnce produces hints and writes them to graph", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("hints", { hints: [{ content: "investigate X" }] }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const hints = graph.unconsumedHints(p.id);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.content, "investigate X");
});

test("metacog-supervisor: stop recommendation becomes a planner hint", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("stop", { reason: "goal met" }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  assert.equal(graph.getProject(p.id)!.status, "active");
  assert.ok(graph.unconsumedHints(p.id).some((hint) => /recommends ending/i.test(hint.content)));
});

test("metacog-supervisor: runOnce writes an applied agent JSON record", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const records = await agentRecords(p);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "applied");
});

test("metacog-supervisor: runOnce worker error marks the JSON record failed", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, "this is not valid json");

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const failed = (await agentRecords(p)).filter((record) => record.status === "failed");
  assert.equal(failed.length, 1);
  assert.ok(failed[0]!.errorMessage);
});

test("metacog-supervisor: runOnce does NOT run for inactive projects", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  graph.updateProjectStatus(p.id, "paused");
  primeForMetacog(graph, p);

  let metacogCalled = false;
  worker.register(/Metacog Role/i, () => { metacogCalled = true; return env("hints", { hints: [] }); });

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  assert.equal(metacogCalled, false);
  assert.equal((await agentRecords(p)).length, 0);
});

test("metacog-supervisor: unchanged trigger state is coalesced", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.metacog.triggers = { everySteps: 1, stagnationLevel: 99 };
  const p = createProject(graph);
  primeForMetacog(graph, p);
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  const sup = new MetacogSupervisor(graph, worker, config, 1);
  await sup.runOnce();
  await sup.runOnce();

  assert.equal((await agentRecords(p)).filter((record) => record.profileId === "metacog").length, 1);
});

test("metacog-supervisor: concurrent triggers share one lock-free in-flight execution", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.metacog.triggers = { everySteps: 1, stagnationLevel: 99 };
  const p = createProject(graph);
  primeForMetacog(graph, p);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  worker.register(/Metacog Role/i, async () => {
    calls += 1;
    await held;
    return env("hints", { hints: [] });
  });
  const sup = new MetacogSupervisor(graph, worker, config, 1);

  const first = sup.runOnce();
  const second = sup.runOnce();
  for (let attempt = 0; attempt < 100 && calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(
    (await agentRecords(p)).filter((record) => record.profileId === "metacog" && record.status === "running").length,
    1,
    "both triggers must share one in-flight execution",
  );
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});
