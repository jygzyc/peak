import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig, TaskType } from "../dist/config/types.js";
import { GraphClient } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { ProjectLoop } from "../dist/project/project-loop.js";
import { ExecutionRegistry } from "../dist/runtime/execution-registry.js";

/** Records every dispatched phase and never resolves, so we can observe in-flight state. */
class RecordingExecutor {
  readonly dispatched: Array<{ kind: TaskType; executionId: string; intentId?: string }> = [];
  readonly projectDir: string;
  readonly logEvents: Array<Record<string, unknown>> = [];
  cleanupCalls = 0;
  private readonly pending = new Set<Promise<void>>();
  constructor(projectDir = "/") { this.projectDir = projectDir; }
  reserveWorker(taskType: TaskType): string | undefined { return taskType; }
  logEvent(type: string, data: Record<string, unknown>): void { this.logEvents.push({ type, ...data }); }
  cleanupRuntimeTmp(): void { this.cleanupCalls += 1; }
  plan(_projectId: string, executionId: string): Promise<void> { return this.track("plan", executionId); }
  supervise(_projectId: string, executionId: string): Promise<void> { return this.track("supervise", executionId); }
  execute(_projectId: string, _intent: { id: string }, executionId: string): Promise<void> { return this.track("execute", executionId, _intent.id); }
  private track(kind: TaskType, executionId: string, intentId?: string): Promise<void> {
    this.dispatched.push({ kind, executionId, intentId });
    const promise = new Promise<void>(() => undefined);
    this.pending.add(promise);
    return promise;
  }
  inFlight(): number { return this.pending.size; }
}

/** Rejects every phase so dispatch failure logging can be observed. */
class FailingExecutor extends RecordingExecutor {
  constructor(projectDir = "/") { super(projectDir); }
  override plan(_projectId: string, executionId: string): Promise<void> { return Promise.reject(new Error("boom")); }
  override supervise(_projectId: string, executionId: string): Promise<void> { return Promise.reject(new Error("boom")); }
  override execute(_projectId: string, _intent: { id: string }, executionId: string): Promise<void> { return Promise.reject(new Error("boom")); }
}

test("ProjectLoop records phase_failed events in the Project log", async () => {
  const projects = mkdtempSync(join(tmpdir(), "peak-loop-"));
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "open", goal: "done", scope: "s" });
    const projectDir = join(projects, project.id);
    const executions = new ExecutionRegistry();
    const executor = new FailingExecutor(projectDir);
    const loop = new ProjectLoop(project.id, config(), graph, executor as never, executions, () => 0);
    await loop.tick();
    // Dispatch failures are logged asynchronously; wait until executions drain.
    const deadline = Date.now() + 3_000;
    while (executions.count() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const failed = executor.logEvents.filter((event) => event.type === "phase_failed");
    assert.ok(failed.length >= 1, "at least one phase_failed recorded");
    for (const event of failed) {
      assert.equal(event.projectId, project.id);
      assert.equal(event.message, "boom");
      assert.ok(typeof event.kind === "string" && event.executionId);
    }
  } finally {
    await server.stop();
    registry.close();
    rmSync(projects, { recursive: true, force: true });
  }
});

function config(): ResolvedTaskConfig {
  return {
    configPath: "/t.json", taskDir: "/",
    board: { skills: [], projects: [{ source: "start", goal: "done" }] },
    workers: { solo: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, env: {} } },
    scheduler: { maxRunningProjects: 4, intervalMs: 60_000 },
    phase: { plan: {}, supervise: { intervalMs: 0 }, execute: { maxArtifactBytes: 1024, customProfiles: [] } },
  };
}

test("ProjectLoop dispatches Plan and Supervise concurrently and Execute up to its per-Project budget", async () => {
  const projects = mkdtempSync(join(tmpdir(), "peak-loop-"));
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "open", goal: "done", scope: "s" });
    // Create one open Intent from origin so the Execute channel has work to do.
    await graph.createIntent(project.id, {
      from: [{ projectId: project.id, factId: "origin", description: "open" }],
      customProfile: null, customProfileDigest: null, hintIds: [],
      description: "first atomic step", createdBy: "test",
    });
    const executions = new ExecutionRegistry();
    const executor = new RecordingExecutor();
    const loop = new ProjectLoop(project.id, config(), graph, executor as never, executions, () => 0);

    // First tick with supervise intervalMs=0 (always due) and no Plan checkpoint:
    // both control channels dispatch, plus Execute for the single open intent
    // (the completion intent origin->goal exists from createProject).
    const started = await loop.tick();
    const kinds = executor.dispatched.map((item) => item.kind).sort();
    assert.ok(kinds.includes("supervise"), "Supervise dispatched");
    assert.ok(kinds.includes("plan"), "Plan dispatched");
    assert.ok(kinds.includes("execute"), "Execute dispatched");
    assert.ok(started >= 1, "returns the count of Execute dispatches");

    // Per-Project budget caps concurrent Execute dispatches: with one Execute
    // already in-flight and executeCapacity=1, a second open Intent stays idle.
    await graph.createIntent(project.id, {
      from: [{ projectId: project.id, factId: "origin", description: "open" }],
      customProfile: null, customProfileDigest: null, hintIds: [],
      description: "second atomic step", createdBy: "test",
    });
    const beforeSecond = executor.dispatched.length;
    await loop.tick();
    assert.equal(executor.dispatched.length, beforeSecond, "in-flight Execute consumes the Project's own budget");
  } finally {
    await server.stop();
    registry.close();
    rmSync(projects, { recursive: true, force: true });
  }
});

test("ProjectLoop Execute budgets are independent across Projects", async () => {
  const projects = mkdtempSync(join(tmpdir(), "peak-loop-"));
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    // One execute Worker with maxRunning 1: per-Project capacity is 1, so each
    // Project may run its own single Execute without sharing budget.
    const first = await graph.createProject({ title: "A", target: "open", goal: "done A", scope: "s" });
    const second = await graph.createProject({ title: "B", target: "open", goal: "done B", scope: "s" });
    for (const project of [first, second]) {
      await graph.createIntent(project.id, {
        from: [{ projectId: project.id, factId: "origin", description: "open" }],
        customProfile: null, customProfileDigest: null, hintIds: [],
        description: "atomic step", createdBy: "test",
      });
    }
    const executions = new ExecutionRegistry();
    const executor = new RecordingExecutor();
    const loopA = new ProjectLoop(first.id, config(), graph, executor as never, executions, () => 0);
    const loopB = new ProjectLoop(second.id, config(), graph, executor as never, executions, () => 0);

    // Both loops start their own Execute in the same tick; neither is starved
    // by the other's in-flight Execute.
    const startedA = await loopA.tick();
    const startedB = await loopB.tick();
    assert.ok(startedA >= 1, "Project A starts its Execute");
    assert.ok(startedB >= 1, "Project B starts its Execute despite A's in-flight Execute");
    assert.equal(executions.count(undefined, "execute"), 2, "both Execute executions are in-flight");
    assert.equal(executor.dispatched.filter((item) => item.kind === "execute").length, 2, "one Execute dispatched per Project");
  } finally {
    await server.stop();
    registry.close();
    rmSync(projects, { recursive: true, force: true });
  }
});

test("ProjectLoop cleans up the per-Project runtime scratch directory once the Project is no longer active", async () => {
  const projects = mkdtempSync(join(tmpdir(), "peak-loop-"));
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "open", goal: "done", scope: "s" });
    const executor = new RecordingExecutor();
    const loop = new ProjectLoop(project.id, config(), graph, executor as never, new ExecutionRegistry(), () => 0);
    await graph.setStatus(project.id, "stopped");
    const started = await loop.tick();
    assert.equal(started, 0, "a non-active Project dispatches no work");
    assert.equal(executor.cleanupCalls, 1, "runtime scratch directory is cleaned when the Project is no longer active");
  } finally {
    await server.stop();
    registry.close();
    rmSync(projects, { recursive: true, force: true });
  }
});
