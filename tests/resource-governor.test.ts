import { test } from "node:test";
import { strict as assert } from "node:assert";
import { GlobalResourceGovernor } from "../dist/worker/resource-governor.js";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { SessionLoop } from "../dist/session/session-loop.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import type { WorkerPool, WorkerRequest } from "../dist/worker/worker-runtime.js";
import { createProject, env, minimalConfig } from "./helper.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TrackingWorker implements WorkerPool {
  active = 0;
  peak = 0;
  calls = 0;

  async execute(request: WorkerRequest) {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.calls += 1;
    try {
      await sleep(15);
      if (/# Evaluator Role/i.test(request.prompt)) {
        return {
          workerId: "tracking",
          returncode: 0,
          text: env("verdict", { decision: "pass", reason: "verified" }),
        };
      }
      const intent = /work-a/i.test(request.prompt) ? "a" : "b";
      return {
        workerId: "tracking",
        returncode: 0,
        text: env("fact", {
          description: `result-${intent}`,
          evidence: [`fixture-${intent}`],
          confidence: 0.9,
        }),
      };
    } finally {
      this.active -= 1;
    }
  }

  pickWorker() { return "mock"; }
  runningCount() { return this.active; }
}

test("GlobalResourceGovernor: quota must be an integer or Infinity", () => {
  assert.throws(() => new GlobalResourceGovernor(0), /positive integer/);
  assert.throws(() => new GlobalResourceGovernor(1.5), /positive integer/);
  assert.doesNotThrow(() => new GlobalResourceGovernor(Infinity));
});

test("GlobalResourceGovernor: an aborted FIFO waiter never consumes a permit", async () => {
  const governor = new GlobalResourceGovernor(1);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = governor.execute(undefined, async () => firstGate);
  const controller = new AbortController();
  const waiting = governor.execute(controller.signal, async () => "must-not-run");
  controller.abort(new Error("cancelled while queued"));
  await assert.rejects(waiting, /cancelled while queued/);
  assert.equal(governor.pendingCount, 0);
  releaseFirst();
  await first;
  assert.equal(governor.activeCount, 0);
});

test("GlobalSupervisor: globalMaxConcurrent limits actual explorer/evaluator calls inside one tick", async () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  graph.addIntent(project.id, { description: "work-a", creator: "planner", dispatchRequested: true });
  graph.addIntent(project.id, { description: "work-b", creator: "planner", dispatchRequested: true });
  const config = minimalConfig();
  config.scheduler = { maxConcurrent: 4, refillPerTick: 4 };
  const worker = new TrackingWorker();
  const loop = new SessionLoop(graph, worker, config);
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus(), globalMaxConcurrent: 1 });
  supervisor.register("governed-session", loop, { projectId: project.id, scope: "governed" });

  await supervisor.tick();

  assert.equal(worker.calls, 4, "two explorers and two evaluators should execute");
  assert.equal(worker.peak, 1, "actual worker concurrency must obey the global permit");
  assert.equal(graph.facts(project.id, "pass").length, 2);
  assert.equal(supervisor.resourceGovernor.activeCount, 0);
});
