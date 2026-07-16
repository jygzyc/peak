import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestGraph } from "./test-graph.ts";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import type { WorkerPool, WorkerRequest } from "../dist/worker/worker-runtime.js";
import { createProject, env, minimalConfig } from "./helper.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CountingPlanner implements WorkerPool {
  calls = 0;
  async execute(_request: WorkerRequest) {
    this.calls += 1;
    await sleep(20);
    return {
      workerId: "planner",
      returncode: 0,
      text: env("decisions", {
        createIntents: [{ description: "held work", dispatchExplorer: false }],
        dispatchExplorerIntentIds: [],
        stopExplorers: [],
        failIntents: [],
        consumeHints: [],
        concludeRun: null,
      }),
    };
  }
  pickWorker() { return "mock"; }
  runningCount() { return 0; }
}

test("SubagentRun lease: dispatchKey deduplicates an active logical execution", () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  const input = {
    profileId: "planner",
    role: "planner" as const,
    workerName: "mock",
    dispatchKey: "planner",
  };

  const first = graph.createSubagentRun(project.id, input);
  const duplicate = graph.createSubagentRun(project.id, input);
  assert.equal(duplicate.id, first.id);

  const claim = graph.claimSubagentRun(project.id, first.id, "coordinator-a", 1_000);
  assert.ok(claim);
  assert.equal(claim!.attempt, 1);
  assert.equal(graph.claimSubagentRun(project.id, first.id, "coordinator-b", 1_000), undefined);
});

test("SubagentRun lease: heartbeat keeps a live owner from being swept", async () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  const run = graph.createSubagentRun(project.id, {
    profileId: "planner",
    role: "planner",
    workerName: "mock",
    dispatchKey: "planner",
  });
  const claim = graph.claimSubagentRun(project.id, run.id, "coordinator-a", 80)!;

  await sleep(25);
  graph.heartbeatSubagentRun(project.id, run.id, claim, 200);
  await sleep(70);

  assert.equal(graph.sweepExpiredLeases(), 0);
  assert.equal(graph.getSubagentRun(project.id, run.id)!.status, "running");
  graph.assertSubagentRunClaim(project.id, run.id, claim);
});

test("SubagentRun lease: expired work is reclaimed and stale evaluator output is fenced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-run-lease-"));
  const dbPath = join(dir, "analysis.db");
  const first = new SqliteGraph(dbPath);
  const project = createProject(first);
  const fact = first.addFact(project.id, {
    description: "candidate",
    source: "explorer",
    confidence: 0.8,
  });
  const run = first.createSubagentRun(project.id, {
    profileId: "evaluator",
    role: "evaluator",
    workerName: "mock",
    factId: fact.id,
    dispatchKey: `evaluator:${fact.id}`,
  });
  const stale = first.claimSubagentRun(project.id, run.id, "coordinator-a", 20)!;

  const second = new SqliteGraph(dbPath);
  const same = second.createSubagentRun(project.id, {
    profileId: "evaluator",
    role: "evaluator",
    workerName: "mock",
    factId: fact.id,
    dispatchKey: `evaluator:${fact.id}`,
  });
  assert.equal(same.id, run.id);

  await sleep(35);
  assert.equal(second.sweepExpiredLeases(), 1);
  const current = second.claimSubagentRun(project.id, run.id, "coordinator-b", 1_000)!;
  assert.equal(current.attempt, 2);
  assert.ok(current.epoch > stale.epoch);

  assert.throws(
    () => first.commitEvaluatorResult(
      project.id,
      fact.id,
      run.id,
      { decision: "deny", reason: "stale" },
      stale,
    ),
    /stale or expired subagent run lease/,
  );
  assert.equal(second.getFact(project.id, fact.id)!.status, "candidate");

  second.commitEvaluatorResult(
    project.id,
    fact.id,
    run.id,
    { decision: "pass", reason: "current owner" },
    current,
  );
  assert.equal(second.getFact(project.id, fact.id)!.status, "pass");
  assert.equal(second.getSubagentRun(project.id, run.id)!.status, "completed");

  first.close();
  second.close();
});

test("SessionLoop: two SQLite coordinators execute one logical planner dispatch once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-run-dedup-"));
  const dbPath = join(dir, "analysis.db");
  const first = new SqliteGraph(dbPath);
  const project = createProject(first);
  const second = new SqliteGraph(dbPath);
  const worker = new CountingPlanner();
  const config = minimalConfig();
  const loopA = new SessionLoop(first, worker, config, { coordinatorId: "coordinator-a" });
  const loopB = new SessionLoop(second, worker, config, { coordinatorId: "coordinator-b" });

  await Promise.all([loopA.step(project.id), loopB.step(project.id)]);

  assert.equal(worker.calls, 1);
  assert.equal(first.intents(project.id).length, 1);
  const plannerRuns = first.subagentRuns(project.id, { profileId: "planner" });
  assert.equal(plannerRuns.length, 1);
  assert.equal(plannerRuns[0]!.status, "completed");
  first.close();
  second.close();
});

test("SessionLoop: a stop directive revokes a remote coordinator's persisted run lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "peak-run-stop-"));
  const dbPath = join(dir, "analysis.db");
  const first = new SqliteGraph(dbPath);
  const project = createProject(first);
  const run = first.createSubagentRun(project.id, {
    profileId: "planner",
    role: "planner",
    workerName: "mock",
    dispatchKey: "planner",
  });
  const remoteClaim = first.claimSubagentRun(project.id, run.id, "remote-coordinator", 10_000)!;
  const second = new SqliteGraph(dbPath);
  const loop = new SessionLoop(second, new CountingPlanner(), minimalConfig(), {
    coordinatorId: "control-coordinator",
  });

  loop.addDirective(project.id, { kind: "stop", payload: "operator stop" });

  assert.equal(first.getProject(project.id)!.status, "stopped");
  assert.equal(first.getSubagentRun(project.id, run.id)!.status, "cancelled");
  assert.throws(
    () => first.heartbeatSubagentRun(project.id, run.id, remoteClaim, 10_000),
    /stale or expired subagent run lease/,
  );
  first.close();
  second.close();
});
