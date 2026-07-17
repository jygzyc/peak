import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { minimalConfig, createProject, env } from "./helper.ts";

/**
 * Termination tests for explicit planner EndFact semantics.
 */

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("termination: empty planner decision does not complete the project", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  worker.register(/automated planning module/i, decisions());

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.step(p.id);

  assert.equal(result.type, "idle");
  assert.equal(graph.getProject(p.id)!.status, "active");
  assert.equal(graph.activeEndFact(p.id), undefined);
});

test("termination: rejected work still requires an explicit planner EndFact", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  worker.register(/automated planning module/i, decisions([{ description: "DEAD-END-TASK" }]));
  worker.register(/DEAD-END-TASK/i, env("fact", { description: "wrong", confidence: 0.2 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "bad" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions());

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  const result = await loop.step(p.id);
  assert.equal(result.type, "idle");
  assert.equal(graph.getProject(p.id)!.status, "active");
});

test("termination: paused project returns idle step result", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  graph.updateProjectStatus(p.id, "paused");

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.step(p.id);
  assert.equal(result.type, "idle");
  assert.match(result.reason!, /paused/);
});

test("termination: completed project returns completed step result (via concludeRun)", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  worker.register(/automated planning module/i, decisions([{ description: "TASK" }, { description: "KEEPALIVE" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "goal met" }));
  worker.register(/## Recent Evaluator Verdicts/i, env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: { description: "goal achieved" } }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 5 });
  assert.equal(result.type, "completed", `expected completed, got ${result.type}`);
  assert.equal(graph.getProject(p.id)!.status, "completed");
});

test("run() loops until the planner creates an EndFact", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{ description: "ONE-SHOT" }]));
  worker.register(/ONE-SHOT/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions([], { description: "goal achieved" }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id);
  assert.equal(result.type, "completed");
  assert.ok(graph.endFacts(p.id).length > 0);
});

test("evaluator failure leaves the candidate as candidate (not auto-rejected)", async () => {
  // Previously a transient evaluator error was silently turned into a reject
  // verdict, permanently marking the fact as a dead-end. Now the candidate is
  // left untouched so a later step can retry evaluation.
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  worker.register(/automated planning module/i, decisions([{ description: "EVAL-ERR-TASK" }, { description: "KEEPALIVE" }]));
  worker.register(/EVAL-ERR-TASK/i, env("fact", { description: "needs eval", confidence: 0.9 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, "this is not valid envelope json");

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  const candidate = graph.facts(p.id, "candidate");
  const rejected = graph.facts(p.id, "deny");
  assert.equal(candidate.length, 1, "candidate must remain a candidate (not resolved)");
  assert.equal(rejected.length, 0, "transient evaluator error must NOT auto-reject the fact");
  assert.equal(worker.calls().filter((call) => call.prompt.includes("# Evaluator Role")).length, 1);
});

test("SessionLoop recovery reopens claimed task state without persisted leases", () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  const stale = graph.addIntent(p.id, { description: "STALE-CLAIMED", creator: "planner" });
  graph.claimIntent(p.id, stale.id);

  new SessionLoop(graph, worker, config);
  assert.equal(graph.getIntent(p.id, stale.id)?.status, "open");
  assert.equal("lease" in graph.getIntent(p.id, stale.id)!, false);
});

test("FederationBus: accepted facts are published only after metacog review", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  const bus = new TestFederationBus();
  const insights = bus.recentInsights.bind(bus);
  const loop = new SessionLoop(graph, worker, config, { federationBus: bus, sessionId: "s1" });
  const metacog = new MetacogSupervisor(
    graph,
    worker,
    config,
    undefined,
    { bus, sessionId: "s1", scope: "default" },
  );
  loop.setMetacog(metacog);

  worker.register(/automated planning module/i, decisions([{ description: "EXPLORE-X" }]));
  worker.register(/EXPLORE-X/i, env("fact", { description: "X confirmed", confidence: 0.95 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  await loop.step(p.id);
  const all = insights(20);
  const facts = all.filter((i) => i.kind === "fact");
  const deadEnds = all.filter((i) => i.kind === "dead_end");
  assert.ok(facts.length >= 1, "accepted fact should be published as a fact insight");
  assert.ok(facts.some((i) => i.summary.includes("X confirmed")));
  assert.equal(deadEnds.length, 0, "evaluator must not bypass metacog to publish dead-ends");
  // Source attribution carries the session id.
  assert.equal(facts[0]!.source.sessionId, "s1");
});

test("deferred fact is reactivated when a later accepted fact matches its condition", async () => {
  // A deferred fact (pending + requiredConditions) is reactivated when a later
  // accepted fact's description contains the condition text. The two facts must
  // be evaluated in separate steps (they're concurrent within one step's
  // runEvaluators), so the planner produces them one at a time.
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.planner.cooldownSteps = 0;
  const p = createProject(graph);

  let plannerCall = 0;
  worker.register(/automated planning module/i, () => {
    plannerCall += 1;
    if (plannerCall === 1) return decisions([{ description: "TASK-A" }]);
    if (plannerCall === 2) return decisions([{ description: "TASK-B" }]);
    return decisions();
  });
  worker.register(/TASK-A/i, env("fact", { description: "admin panel exists", confidence: 0.9 }));
  worker.register(/TASK-B/i, env("fact", { description: "obtained admin token via JWT bypass", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pending", reason: "needs token", requiredConditions: ["admin token"] }));
  // Override: second evaluation (TASK-B) should accept. Use a counter on the
  // evaluator mock that flips after the first defer.
  let evalCount = 0;
  worker.register(/Evaluator Role/i, () => {
    evalCount += 1;
    if (evalCount === 1) return env("verdict", { decision: "pending", reason: "needs token", requiredConditions: ["admin token"] });
    return env("verdict", { decision: "pass", reason: "token found" });
  });
  // The verdict-triggered planner call produces TASK-B (second direction).
  // On subsequent verdict-triggered calls there is nothing new to add, so
  // conclude the run — otherwise the loop re-dispatches TASK-B forever.
  let verdictBlockCallCount = 0;
  worker.register(/## Recent Evaluator Verdicts/i, () => {
    verdictBlockCallCount += 1;
    if (verdictBlockCallCount === 1) return decisions([{ description: "TASK-B" }]);
    return decisions([], { description: "reactivation done" });
  });

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });

  const reactivated = graph.events(p.id).find((e) => e.type === "fact.reactivated");
  assert.ok(reactivated, "deferred fact should be reactivated when condition is met");
});

test("persistently failing explorer fails the project without inventing a semantic dead-end", async () => {
  // An explorer that always returns unparseable output would, without the
  // auto-fail guard, release the intent back to "open" every step and be
  // re-dispatched forever — no verdict is ever produced to wake the planner,
  // so loop.run() would never terminate. After MAX_EXPLORER_RETRIES the loop
  // fails the Project without inventing an Intent denial or dead-end.
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{ description: "BROKEN" }]));
  worker.register(/# Explorer Role/i, "this is not valid json"); // always fails to parse
  // After BROKEN is auto-failed, the planner has no intents and no verdicts, so
  // it concludes (second planner tick).
  worker.register(/## Recent Evaluator Verdicts/i, decisions([], { description: "nothing left" }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 1 });

  assert.equal(result.type, "failed", "run must terminate, not deadlock");
  const intent = graph.intents(p.id)[0]!;
  assert.equal(intent.status, "open", "transport failure must not become planner semantic deny");
  const autoFailed = graph.events(p.id).find((e) => e.type === "intent.auto_failed");
  assert.equal(autoFailed, undefined);
  assert.equal(worker.calls().filter((call) => call.prompt.includes("# Explorer Role")).length, 3);
});
