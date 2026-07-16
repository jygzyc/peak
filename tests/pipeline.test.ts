import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[], failIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents, consumeHints: [], concludeRun });
}

test("e2e: planner creates intent, explorer executes, evaluator accepts, stopGate fires", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph, { goal: "ACHIEVE_X" });
  let round = 0;
  worker.register(/automated planning module/i, () => {
    round++;
    return round === 1 ? decisions([{ description: "SOLVE: achieve X" }]) : decisions([], [], { description: "goal met" });
  });
  worker.register(/SOLVE: achieve X/i, env("fact", { description: "X achieved", confidence: 0.95 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 5 });
  assert.equal(result.type, "completed");
  assert.ok(graph.facts(p.id, "pass").map((f) => f.description).includes("X achieved"));
});

test("e2e: planner fails intent (kills explorer) in response to stop-explorer hint", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  let hintBlockDone = false;
  let plannerOpened = false;
  worker.register(/automated planning module/i, () => {
    // Open the two intents only once; subsequent planner ticks (verdict-driven)
    // route through the hint/verdict fallbacks below, not here.
    if (!plannerOpened) { plannerOpened = true; return decisions([{ description: "WRONG-DIR" }, { description: "KEEPALIVE" }]); }
    return decisions([], [], { description: "nothing new" });
  });
  worker.register(/WRONG-DIR/i, env("fact", { description: "partial", confidence: 0.3 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "x" }));
  worker.register(/## Hints Requiring Response/i, () => {
    // First hint-triggered call fails i001 per the hint; subsequent calls have
    // nothing new — conclude so the run terminates (no maxSteps safety net).
    if (!hintBlockDone) {
      hintBlockDone = true;
      return env("decisions", {
        createIntents: [],
        failIntents: [{ intentId: "i001", reason: "hint says stop" }],
        consumeHints: ["h001"],
        concludeRun: null,
      });
    }
    return decisions([], [], { description: "hint handled" });
  });
  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  graph.addHint(p.id, { content: "stop WRONG-DIR", creator: "metacog", kind: "stop-explorer", targetIntentId: "i001" });
  await loop.run(p.id, { idlePollMs: 5 });
  const i001 = graph.getIntent(p.id, "i001");
  assert.ok(i001);
  assert.equal(i001!.status, "deny");
  assert.equal(i001!.killedBy, "planner");
  const unconsumedHints = graph.unconsumedHints(p.id);
  assert.equal(unconsumedHints.length, 0, "hint should be consumed after planner acts on it");
});

test("e2e: explorer blocked → candidate describing obstacle → evaluator rejects → planner fails intent", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  let plannerOpenedB = false;
  worker.register(/automated planning module/i, () => {
    if (!plannerOpenedB) { plannerOpenedB = true; return decisions([{ description: "BLOCKED-TASK" }, { description: "KEEPALIVE" }]); }
    return decisions([], [], { description: "nothing new" });
  });
  worker.register(/BLOCKED-TASK/i, env("fact", { description: "blocked: missing tool", confidence: 0.2 }));
  worker.register(/KEEPALIVE/i, env("fact", { description: "ok", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "no progress" }));
  let blockedBlockDone = false;
  worker.register(/## Recent Evaluator Verdicts/i, () => {
    if (!blockedBlockDone) { blockedBlockDone = true; return decisions([], [{ intentId: "i001", reason: "rejected by evaluator" }]); }
    return decisions([], [], { description: "blocked path handled" });
  });
  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });
  const i001 = graph.getIntent(p.id, "i001");
  assert.ok(i001);
  assert.equal(i001!.status, "deny");
});

test("e2e: planner can conclude the run via concludeRun decision", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/automated planning module/i, decisions([{ description: "TASK-Z" }]));
  worker.register(/TASK-Z/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "goal met" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions([], [], { description: "goal achieved" }));
  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { idlePollMs: 5 });
  assert.equal(result.type, "completed");
  assert.equal(graph.getProject(p.id)!.status, "completed");
});

test("GlobalSupervisor ticks separate one-task session runtimes concurrently", async () => {
  const graph1 = new TestGraph();
  const graph2 = new TestGraph();
  const config1 = minimalConfig();
  const config2 = minimalConfig();
  const p1 = createProject(graph1, { session: "s1" });
  const p2 = createProject(graph2, { session: "s2" });
  const loop1 = new SessionLoop(graph1, new MockWorker().registerDefaults(), config1);
  const loop2 = new SessionLoop(graph2, new MockWorker().registerDefaults(), config2);
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  supervisor.register("s1", loop1, { projectId: p1.id, scope: "pair" });
  supervisor.register("s2", loop2, { projectId: p2.id, scope: "pair" });
  for (let i = 0; i < 10; i++) {
    await supervisor.tick();
    if (graph1.getProject(p1.id)?.status === "completed"
      && graph2.getProject(p2.id)?.status === "completed") break;
  }
  assert.equal(graph1.getProject(p1.id)!.status, "completed");
  assert.equal(graph2.getProject(p2.id)!.status, "completed");
});
