import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerPool, workerDefinitions } from "../../dist/runtime/worker-pool.js";
import type { ResolvedTaskConfig, TaskType, WorkerConfig } from "../../dist/utils/types.js";
import type { ProcessResult, WorkerProtocol, WorkerType } from "../../dist/worker/types.js";
import { WorkerRuntime } from "../../dist/worker/worker-runtime.js";
import { fakeWorkerRunner } from "../helpers/fakes.ts";

const OK: ProcessResult = { stdout: "ok", stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true };
const FAIL: ProcessResult = { stdout: "", stderr: "boom", returncode: 1, timedOut: false, cancelled: false, started: true };

/** Minimal protocol: the prompt goes to stdin, stdout is the text. */
function echoProtocol(type: string): WorkerProtocol {
  return {
    type: type as never, canResume: false,
    build: () => ({ argv: ["x"], input: "p" }),
    parse: (result: ProcessResult) => ({ text: result.stdout }),
  };
}

function worker(priority: number, maxRunning = 1, taskTypes: TaskType[] = ["plan", "supervise", "execute"]): WorkerConfig {
  return { type: "pi", taskTypes, maxRunning, priority, env: {} };
}

function config(workers: Record<string, WorkerConfig>): ResolvedTaskConfig {
  return {
    configPath: "/t.json", taskDir: "/",
    board: { skills: [], projects: [{ source: "start", goal: "done" }] },
    execution: { mode: "local" },
    workers,
    scheduler: { maxRunningProjects: 4, intervalMs: 3_000 },
    phase: { plan: {}, supervise: { intervalMs: 1_000 }, execute: { maxArtifactBytes: 1024, customProfile: [] } },
  };
}

function pool(value: ResolvedTaskConfig, result: ProcessResult): WorkerPool {
  const { runner } = fakeWorkerRunner(result);
  const runtime = new WorkerRuntime(workerDefinitions(value), runner, { pi: echoProtocol("pi") } as Record<WorkerType, WorkerProtocol>);
  return new WorkerPool(value, runtime);
}

test("pick prefers the lowest priority value and breaks ties by name", () => {
  const target = pool(config({ b: worker(1), a: worker(1), c: worker(2) }), OK);
  assert.equal(target.pick("plan"), "a");
  assert.equal(target.pick("supervise"), "a");
});

test("pick gates execute workers at maxRunning until release", () => {
  const target = pool(config({ w: worker(1, 1) }), OK);
  assert.equal(target.pick("execute"), "w");
  assert.equal(target.pick("execute"), undefined, "reserved worker is at capacity");
  target.release("w", "execute");
  assert.equal(target.pick("execute"), "w");
  // Releasing a non-execute phase is a no-op and never over-releases.
  target.release("w", "plan");
  target.release("w", "execute");
  assert.equal(target.pick("execute"), "w");
});

test("a failed execute run cools the worker down so pick routes elsewhere", async () => {
  const target = pool(config({ "a-fail": worker(1, 1), "b-ok": worker(1, 1) }), FAIL);
  const first = target.pick("execute");
  assert.equal(first, "a-fail");
  const result = await target.execute(first!, "execute", "prompt", 1_000, "/tmp");
  assert.equal(result.returncode, 1);
  assert.equal(target.pick("execute"), "b-ok", "failed worker is skipped during its cooldown");
});

test("a successful execute run keeps the worker pickable", async () => {
  const target = pool(config({ "a-one": worker(1, 1), "b-two": worker(1, 1) }), OK);
  const first = target.pick("execute");
  await target.execute(first!, "execute", "prompt", 1_000, "/tmp");
  assert.equal(target.pick("execute"), "a-one", "no cooldown after success; ties break by name");
});

test("execute rejects a worker that is not routed for the task type", async () => {
  const target = pool(config({ planner: worker(1, 1, ["plan"]) }), OK);
  await assert.rejects(
    target.execute("planner", "execute", "prompt", 1_000, "/tmp"),
    /worker is not routed for execute: planner/,
  );
});

test("workerDefinitions strips routing metadata before it crosses into src/worker", () => {
  const value = config({ w: worker(2, 3) });
  assert.deepEqual(workerDefinitions(value), {
    workers: { w: { type: "pi", model: undefined, env: {} } },
  });
});
