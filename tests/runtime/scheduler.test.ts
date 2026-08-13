import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionRegistry } from "../../dist/runtime/execution-registry.js";
import type { ProjectLoop } from "../../dist/runtime/project-loop.js";
import { RuntimeScheduler } from "../../dist/runtime/scheduler.js";
import type { ResolvedTaskConfig } from "../../dist/utils/types.js";

interface FakeLoop {
  projectId: string;
  ticks: number;
  disposed: boolean;
  tick: () => Promise<void>;
  dispose: () => void;
}

/** Duck-typed ProjectLoop that records ticks; optionally gates the first tick. */
function fakeLoop(projectId: string, tick?: () => Promise<void>): FakeLoop {
  const loop: FakeLoop = {
    projectId,
    ticks: 0,
    disposed: false,
    async tick() { loop.ticks += 1; await tick?.(); },
    dispose() { loop.disposed = true; },
  };
  return loop;
}

function config(scheduler: Partial<ResolvedTaskConfig["scheduler"]> = {}): ResolvedTaskConfig {
  return {
    configPath: "/t.json", taskDir: "/",
    board: { skills: [], projects: [] },
    execution: { mode: "local" },
    workers: {},
    scheduler: { maxRunningProjects: 2, intervalMs: 1_000, ...scheduler },
    phase: { plan: {}, supervise: { intervalMs: 1_000 }, execute: { maxArtifactBytes: 1024, customProfile: [] } },
  };
}

/** Waits one macrotask so the fire-and-forget tick promise chain settles. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ticks rotate through loops round-robin within the project capacity", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
  const scheduler = new RuntimeScheduler(config(), new ExecutionRegistry());
  const loops = [fakeLoop("p1"), fakeLoop("p2"), fakeLoop("p3")];
  for (const loop of loops) scheduler.add(loop as unknown as ProjectLoop);

  scheduler.start(); // immediate first tick: p1, p2 (capacity 2)
  await settle();
  assert.deepEqual(loops.map((loop) => loop.ticks), [1, 1, 0]);

  t.mock.timers.tick(1_000); // cursor resumes at p3: p3, p1
  await settle();
  assert.deepEqual(loops.map((loop) => loop.ticks), [2, 1, 1]);

  t.mock.timers.tick(1_000); // cursor resumes at p2: p2, p3
  await settle();
  assert.deepEqual(loops.map((loop) => loop.ticks), [2, 2, 2]);
  scheduler.stop();
});

test("a tick in progress suppresses re-entrant ticks", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
  const scheduler = new RuntimeScheduler(config({ maxRunningProjects: 1 }), new ExecutionRegistry());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = fakeLoop("p1", () => gate);
  const second = fakeLoop("p2");
  scheduler.add(first as unknown as ProjectLoop);
  scheduler.add(second as unknown as ProjectLoop);

  scheduler.start();
  await settle();
  assert.equal(first.ticks, 1);

  t.mock.timers.tick(1_000); // interval fires while the first tick is still gated
  await settle();
  assert.equal(first.ticks, 1, "re-entrant tick was skipped");
  assert.equal(second.ticks, 0, "gated tick never reached the next loop");

  release();
  await settle();
  t.mock.timers.tick(1_000); // next tick proceeds normally
  await settle();
  assert.equal(second.ticks, 1);
  scheduler.stop();
});

test("a failing loop tick is absorbed and the scheduler keeps ticking", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
  const errors: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, "write", (chunk: unknown) => { errors.push(String(chunk)); return true; });
  const scheduler = new RuntimeScheduler(config({ maxRunningProjects: 1 }), new ExecutionRegistry());
  const failing = fakeLoop("p1", () => Promise.reject(new Error("graph closed")));
  scheduler.add(failing as unknown as ProjectLoop);

  scheduler.start();
  await settle();
  await settle();
  assert.equal(failing.ticks, 1);
  assert.ok(errors.some((line) => line.includes("scheduler tick failed: graph closed")), `stderr captured: ${errors}`);

  t.mock.timers.tick(1_000); // the failure did not kill the interval
  await settle();
  await settle();
  assert.equal(failing.ticks, 2);
  scheduler.stop();
  void original;
});

test("stop clears the interval, disposes loops, and cancels executions", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
  const executions = new ExecutionRegistry();
  const controller = new AbortController();
  executions.add({
    executionId: "e1", projectId: "p1", kind: "execute", startedAt: Date.now(), controller,
  });
  const scheduler = new RuntimeScheduler(config(), executions);
  const loop = fakeLoop("p1");
  scheduler.add(loop as unknown as ProjectLoop);

  scheduler.start();
  await settle();
  assert.equal(loop.ticks, 1);

  scheduler.stop();
  assert.ok(loop.disposed);
  assert.ok(controller.signal.aborted);

  t.mock.timers.tick(5_000); // the interval is gone: no further ticks
  await settle();
  assert.equal(loop.ticks, 1);
});
