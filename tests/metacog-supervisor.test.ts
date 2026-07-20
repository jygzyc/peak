import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { roleLogs, minimalConfig, createProject, env } from "./helper.ts";

function makeSupervisor(graph: TestGraph, worker: MockWorker) {
  return new MetacogSupervisor(graph, worker, minimalConfig());
}

function primeForMetacog(graph: TestGraph, p: ReturnType<typeof createProject>) {
  const f = graph.addFact(p.id, { description: "accepted fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f.id, { decision: "pass", reason: "ok" });
  return f;
}

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

test("metacog-supervisor: runOnce writes metacog context and output logs", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const records = await roleLogs(p);
  assert.deepEqual(records.map((entry) => [entry.role, entry.kind]), [
    ["metacog", "context"],
    ["metacog", "output"],
  ]);
});

test("metacog-supervisor: invalid output records context and failure output", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, "this is not valid json");

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const logs = await roleLogs(p);
  assert.deepEqual(logs.map((entry) => entry.kind), ["context", "output"]);
  assert.match((logs[1]!.data as { error: string }).error, /no JSON object/);
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
  assert.equal((await roleLogs(p)).length, 0);
});

test("metacog-supervisor: one pass Fact triggers one review", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  primeForMetacog(graph, p);
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  const sup = new MetacogSupervisor(graph, worker, config);
  await sup.runOnce();
  await sup.runOnce();

  assert.equal((await roleLogs(p)).filter((entry) => entry.role === "metacog" && entry.kind === "output").length, 1);
});

test("metacog-supervisor: every pass Fact produces one unified broadcast", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  const first = primeForMetacog(graph, p);
  const second = graph.addFact(p.id, { description: "another accepted fact", source: "explorer" });
  graph.resolveFact(p.id, second.id, { decision: "pass", reason: "second verified" });
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));
  const bus = new TestFederationBus();
  bus.registerSession(p.sessionId, "scope", p.id, graph);

  const sup = new MetacogSupervisor(graph, worker, config, {
    bus,
    sessionId: p.sessionId,
    scope: "scope",
  });
  await sup.runOnce();

  assert.deepEqual(
    bus.recentBroadcasts(10, "scope").map((broadcast) => broadcast.factId).sort(),
    [first.id, second.id].sort(),
  );
  assert.equal((await roleLogs(p)).filter((entry) => entry.role === "metacog" && entry.kind === "output").length, 2);
});

test("metacog-supervisor: concurrent calls share one lock-free execution", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
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
  const sup = new MetacogSupervisor(graph, worker, config);

  const first = sup.runOnce();
  const second = sup.runOnce();
  for (let attempt = 0; attempt < 100 && calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal((await roleLogs(p)).filter((entry) => entry.role === "metacog" && entry.kind === "context").length, 1);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});
