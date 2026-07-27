import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig, TaskType } from "../dist/config/types.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GraphClient } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { TaskExecutor, type TaskWorkers } from "../dist/runtime/task-executor.js";
import type { SessionRef, WorkerResult } from "../dist/worker/types.js";

class FakeWorkers implements TaskWorkers {
  readonly outputs: Record<TaskType, string[]> = { plan: [], supervise: [], execute: [] };
  pick(): string { return "fake"; }
  async execute(_name: string, type: TaskType, _prompt: string, _timeout: number, _cwd: string, _signal?: AbortSignal, _session?: SessionRef): Promise<WorkerResult> {
    return { text: this.outputs[type].shift()!, stdout: "", stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true };
  }
}

test("Plan, Supervise and Execute mutate Graph only through HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-task-"));
  const projects = join(root, "projects");
  const workspace = join(root, "workspace");
  mkdirSync(projects, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const projectDir = join(projects, project.id);
    const federation = new FederationBus();
    federation.register(project.id, projectDir, project.scope);
    const workers = new FakeWorkers();
    const config = configuration(root, workspace);
    const executor = new TaskExecutor(config, graph, workers, federation, projectDir);

    workers.outputs.supervise.push('{"kind":"hint","content":"Verify the result independently"}');
    await executor.supervise(project.id, "s1");
    workers.outputs.plan.push(`{"kind":"intents","intents":[{"from":[{"projectId":"${project.id}","factId":"origin"}],"description":"Do the work"}]}`);
    await executor.plan(project.id, "p1");
    const intent = (await graph.getProject(project.id)).intents[0]!;
    writeFileSync(join(workspace, "report.md"), "details\n");
    workers.outputs.execute.push('{"kind":"fact","description":"Work completed","artifact":{"localPath":"report.md","mediaType":"text/markdown"}}');
    await executor.execute(project.id, intent, "e1");
    workers.outputs.plan.push(`{"kind":"complete","from":[{"projectId":"${project.id}","factId":"f001"}],"description":"Goal proven"}`);
    await executor.plan(project.id, "p2");

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    assert.equal(result.hints.length, 1);
    assert.equal(result.facts.find((fact) => fact.id === "f001")?.artifact?.mediaType, "text/markdown");
    const logs = readdirSync(join(projectDir, "logs"));
    assert.ok(logs.some((name) => /^graph-.*-supervise\.yaml$/.test(name)));
    const executeLog = logs.find((name) => /^graph-.*-execute\.yaml$/.test(name));
    assert.ok(executeLog);
    assert.match(readFileSync(join(projectDir, "logs", executeLog), "utf8"), /description: "Do the work"/);
    assert.equal(logs.some((name) => name.includes("output")), false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function configuration(root: string, workspace: string): ResolvedTaskConfig {
  return {
    configPath: join(root, "task.json"), taskDir: root,
    task: { target: "start", goal: "done", workspace, skills: [] },
    workers: { fake: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, args: [] } },
    scheduler: { maxConcurrent: 4, maxRunningProjects: 4, maxProjectConcurrent: 2, refillPerTick: 4, intervalMs: 10 },
    tasks: { plan: { timeoutMs: 1000, maxIntents: 3 }, supervise: { timeoutMs: 1000, intervalMs: 1000 }, execute: { timeoutMs: 1000, finalizeTimeoutMs: 1000, maxArtifactBytes: 1024 } },
    federation: { scope: "s" },
  };
}
