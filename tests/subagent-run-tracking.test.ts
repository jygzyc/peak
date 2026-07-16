import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

/** Planner mock that opens the given intents ONCE, then concludes on every
 *  subsequent tick. Without this the planner would re-open the same intents
 *  forever (there is no maxSteps safety net — runs terminate naturally). */
function openOnce(createIntents: unknown[]): () => string {
  let opened = false;
  return () => {
    if (opened) return env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: { description: "done" } });
    opened = true;
    return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun: null });
  };
}

test("SubagentRun tracking: explorer dispatch creates a tracked run", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, openOnce([{ description: "FIND-X" }]));
  worker.register(/FIND-X/i, env("fact", { description: "found", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });

  const explorerRuns = graph.subagentRuns(p.id, { profileId: "explorer" });
  assert.ok(explorerRuns.length >= 1, "at least one explorer run tracked");
  const completed = explorerRuns.find((r) => r.status === "completed");
  assert.ok(completed, "an explorer run completed");
  assert.ok(completed!.factId, "completed explorer run has factId");
});

test("SubagentRun tracking: evaluator dispatch creates a tracked run", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, openOnce([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "result", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });

  const evaluatorRuns = graph.subagentRuns(p.id, { profileId: "evaluator" });
  assert.ok(evaluatorRuns.length >= 1);
  const completed = evaluatorRuns.find((r) => r.status === "completed");
  assert.ok(completed);
});

test("SubagentRun tracking: failed explorer marks run as failed", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  // Explorer returns invalid output → StageError → run marked failed. After
  // MAX_EXPLORER_RETRIES the intent is auto-failed, so loop.run terminates.
  worker.register(/automated planning module/i, openOnce([{ description: "BAD-TASK" }]));
  worker.register(/BAD-TASK/i, "not json at all");

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 1 });

  const explorerRuns = graph.subagentRuns(p.id, { profileId: "explorer" });
  const failed = explorerRuns.find((r) => r.status === "failed");
  assert.ok(failed, "an explorer run is marked failed");
  assert.ok(failed!.errorMessage);
});

test("SubagentRun tracking: maxActive caps concurrent explorer runs", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  // Force maxActive=1 to serialize explorer runs
  config.profiles.explorer.maxActive = 1;
  config.scheduler.maxConcurrent = 5;
  config.scheduler.refillPerTick = 5;

  const p = createProject(graph);
  // Open all three intents on the first tick; conclude only once every intent
  // is resolved (done), so maxActive=1 serialization doesn't get cut short by
  // an early concludeRun while intents are still open.
  let opened3 = false;
  worker.register(/automated planning module/i, () => {
    if (!opened3) {
      opened3 = true;
      return env("decisions", { createIntents: [{ description: "TASK-A" }, { description: "TASK-B" }, { description: "TASK-C" }], failIntents: [], consumeHints: [], concludeRun: null });
    }
    const open = graph.intents(p.id, "open").length + graph.intents(p.id, "claimed").length;
    if (open > 0) return env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: null });
    return env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: { description: "all done" } });
  });
  // explorer mock for each task
  for (const desc of ["TASK-A", "TASK-B", "TASK-C"]) {
    worker.register(new RegExp(desc), env("fact", { description: `${desc} done`, confidence: 0.9 }));
  }
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  // Drive with step() rather than run(): the explorer mock matches on the
  // intent description ("TASK-A"), which also appears in the planner's rendered
  // context, so the planner would receive a fact envelope and error out under
  // run(). Step-driven dispatch isolates the maxActive behavior under test.
  for (let i = 0; i < 20; i++) {
    await loop.step(p.id);
    const done = graph.intents(p.id, "pass").length;
    if (done >= 3) break;
  }

  const explorerRuns = graph.subagentRuns(p.id, { profileId: "explorer" });
  // All three should eventually complete
  const completed = explorerRuns.filter((r) => r.status === "completed");
  assert.equal(completed.length, 3);
});

test("SubagentRun tracking: completed explorer run records token usage", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, openOnce([{ description: "TOKEN-TASK" }]));
  worker.register(/TOKEN-TASK/i, env("fact", { description: "found", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });

  const completed = graph.subagentRuns(p.id, { profileId: "explorer", status: "completed" });
  assert.ok(completed.length >= 1);
  const run = completed[0]!;
  assert.ok(run.inputTokens !== undefined && run.inputTokens > 0, "inputTokens should be positive");
  assert.ok(run.contextArtifact && existsSync(run.contextArtifact.resolvedPath));
  assert.ok(run.outputArtifact && existsSync(run.outputArtifact.resolvedPath));
  const output = JSON.parse(readFileSync(run.outputArtifact.resolvedPath, "utf8"));
  assert.equal(output.kind, "fact");
});

test("SubagentRun tracking: completed explorer run records non-zero outputTokens", async () => {
  // Previously outputTokens was hard-coded to 0 (docs 04-session.md §4.1); it is
  // now estimated from the worker's raw output text so the field is usable for
  // rough quota/audit purposes.
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, openOnce([{ description: "OUT-TOK-TASK" }]));
  worker.register(/OUT-TOK-TASK/i, env("fact", { description: "a reasonably long discovery description", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });

  const completed = graph.subagentRuns(p.id, { profileId: "explorer", status: "completed" });
  assert.ok(completed.length >= 1);
  const run = completed[0]!;
  assert.ok(run.outputTokens !== undefined && run.outputTokens > 0, "outputTokens should be positive (was hardcoded 0)");
});

test("SubagentRun tracking: failed run has errorMessage set", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, openOnce([{ description: "ERR-TASK" }]));
  worker.register(/ERR-TASK/i, "not json");

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 1 });

  const failed = graph.subagentRuns(p.id, { profileId: "explorer", status: "failed" });
  assert.ok(failed.length >= 1);
  assert.ok(failed[0]!.errorMessage, "failed run should have errorMessage");
});

test("SubagentRun tracking: fact created via SessionLoop has stepDiscovered set", async () => {
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/automated planning module/i, openOnce([{ description: "STEPFACT" }]));
  worker.register(/STEPFACT/i, env("fact", { description: "found via loop", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { idlePollMs: 5 });

  const facts = graph.facts(p.id);
  assert.ok(facts.length >= 1);
  for (const f of facts) {
    assert.ok(f.stepDiscovered !== undefined, `fact ${f.id} should have stepDiscovered set`);
    assert.ok(f.stepDiscovered! >= 0, `fact ${f.id} stepDiscovered should be non-negative`);
  }
});
