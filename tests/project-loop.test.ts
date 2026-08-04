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
  private readonly pending = new Set<Promise<void>>();
  reserveWorker(taskType: TaskType): string | undefined { return taskType; }
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

function config(): ResolvedTaskConfig {
  return {
    configPath: "/t.json", taskDir: "/",
    board: { skills: [], projects: [{ source: "start", goal: "done" }] },
    workers: { solo: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, env: {} } },
    scheduler: { maxRunningProjects: 4, intervalMs: 60_000 },
    phase: { plan: {}, supervise: { intervalMs: 0 }, execute: { maxArtifactBytes: 1024, customProfiles: [] } },
  };
}

test("ProjectLoop dispatches Plan and Supervise concurrently and Execute up to executeSlots", async () => {
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
    const started = await loop.tick(1);
    const kinds = executor.dispatched.map((item) => item.kind).sort();
    assert.ok(kinds.includes("supervise"), "Supervise dispatched");
    assert.ok(kinds.includes("plan"), "Plan dispatched");
    assert.ok(kinds.includes("execute"), "Execute dispatched");
    assert.ok(started >= 1, "returns the count of Execute dispatches");

    // Second tick: no new dispatch because the same kinds are already in-flight.
    const before = executor.dispatched.length;
    await loop.tick(1);
    assert.equal(executor.dispatched.length, before, "no duplicate dispatch while a channel is in-flight");

    // Execute budget caps concurrent Execute dispatches: tick(0) starts none.
    const beforeZero = executor.dispatched.length;
    await loop.tick(0);
    assert.equal(executor.dispatched.length, beforeZero, "executeSlots=0 starts no Execute");
  } finally {
    await server.stop();
    registry.close();
    rmSync(projects, { recursive: true, force: true });
  }
});
