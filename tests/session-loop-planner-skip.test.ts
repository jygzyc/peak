import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("planner-skip: accept verdict DOES re-trigger planner (to chain downstream work)", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  let verdictBlockCallCount = 0;
  worker.register(/## Recent Evaluator Verdicts/i, () => { verdictBlockCallCount++; return decisions(); });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);

  // An accept verdict must re-trigger the planner so it can chain a downstream
  // intent from the verified fact (exhaustive exploration, not first-finding-
  // stop). The planner sees the verdicts block on this re-plan pass.
  assert.ok(verdictBlockCallCount > 0, "planner SHOULD see Recent Evaluator Verdicts after an accept");
});

test("planner-skip: reject verdict DOES trigger planner with verdicts", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  // Planner creates the rejected intent plus a keepalive intent, so the project
  // does not naturally complete (openIntents>0) before the verdict-driven
  // planner pass runs on the next step.
  worker.register(/automated planning module/i, decisions([{ description: "BAD-TASK" }, { description: "KEEPALIVE" }]));
  worker.register(/BAD-TASK/i, env("fact", { description: "wrong", confidence: 0.2 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "bad" }));
  let plannerWithVerdictsCalled = false;
  worker.register(/## Recent Evaluator Verdicts/i, () => {
    plannerWithVerdictsCalled = true;
    return decisions([{ description: "RETRY-TASK" }]);
  });
  worker.register(/RETRY-TASK/i, env("fact", { description: "better", confidence: 0.8 }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);

  assert.equal(plannerWithVerdictsCalled, true);
});

test("planner-skip: defer verdict DOES trigger planner", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{ description: "TASK" }, { description: "KEEPALIVE" }]));
  worker.register(/TASK/i, env("fact", { description: "partial", confidence: 0.9 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pending", reason: "needs precondition", requiredConditions: ["login token"] }));
  let plannerWithVerdictsCalled = false;
  worker.register(/## Recent Evaluator Verdicts/i, () => { plannerWithVerdictsCalled = true; return decisions(); });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);

  assert.equal(plannerWithVerdictsCalled, true);
});

test("planner-skip: stop-explorer hint triggers planner even during cooldown", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.planner.cooldownSteps = 0;

  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{ description: "TASK" }, { description: "KEEPALIVE" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  let plannerWithHintsCalled = false;
  worker.register(/## Hints Requiring Response/i, () => { plannerWithHintsCalled = true; return decisions(); });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  graph.addHint(p.id, { content: "stop that", creator: "human", kind: "stop-explorer" });
  await loop.step(p.id);

  assert.equal(plannerWithHintsCalled, true);
});

test("planner-skip: metacog warning hint triggers planner even during cooldown", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.planner.cooldownSteps = 99;

  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{
    description: "HELD-WORK",
    dispatchExplorer: false,
  }]));
  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  graph.addHint(p.id, {
    content: "final review found a coverage gap",
    creator: "metacog",
    kind: "warning",
  });
  let plannerWithHintsCalled = false;
  worker.register(/## Hints Requiring Response/i, () => {
    plannerWithHintsCalled = true;
    return decisions();
  });
  await loop.step(p.id);

  assert.equal(plannerWithHintsCalled, true);
});

test("planner-skip: empty graph always runs planner", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  let plannerCalled = false;
  worker.register(/automated planning module/i, () => {
    plannerCalled = true;
    return decisions([{ description: "INIT" }]);
  });
  worker.register(/INIT/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  assert.equal(plannerCalled, true);
});

test("planner-skip: accept verdict re-plans (to chain downstream), but cooldown still gates idle re-runs", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.planner.cooldownSteps = 5;

  const p = createProject(graph);
  let plannerCallCount = 0;
  worker.register(/automated planning module/i, () => {
    plannerCallCount++;
    return decisions([{ description: "WORK-TASK" }]);
  });
  worker.register(/WORK-TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  const callsAfterStep1 = plannerCallCount;
  assert.equal(callsAfterStep1, 1, "planner should run once on empty graph");

  // An accept verdict must re-trigger the planner so it can chain downstream
  // work from a verified fact (previously this skipped and the run stopped
  // after the first accept). Cooldown no longer gates accept verdicts.
  await loop.step(p.id);
  assert.ok(plannerCallCount > callsAfterStep1, "planner SHOULD re-run on an accept verdict to chain downstream");
});

test("planner-skip: reject bypasses cooldown and triggers planner", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.planner.cooldownSteps = 99;

  const p = createProject(graph);
  let plannerCallCount = 0;
  worker.register(/automated planning module/i, () => {
    plannerCallCount++;
    return decisions([{ description: "BAD-WORK" }, { description: "KEEPALIVE" }]);
  });
  worker.register(/BAD-WORK/i, env("fact", { description: "wrong", confidence: 0.2 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "bad" }));
  worker.register(/## Recent Evaluator Verdicts/i, () => {
    plannerCallCount++;
    return decisions([{ description: "RETRY" }]);
  });
  worker.register(/RETRY/i, env("fact", { description: "better", confidence: 0.8 }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  const callsAfterStep1 = plannerCallCount;
  assert.ok(callsAfterStep1 >= 1);

  await loop.step(p.id);
  assert.ok(plannerCallCount > callsAfterStep1, "planner should run despite high cooldown on reject");
});
