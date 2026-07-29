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
  readonly outputs: Record<TaskType, Array<string | WorkerResult>> = { plan: [], supervise: [], execute: [] };
  readonly calls: Array<{ type: TaskType; prompt: string; session?: SessionRef }> = [];
  pick(): string { return "fake"; }
  async execute(_name: string, type: TaskType, prompt: string, _timeout: number, _cwd: string, _signal?: AbortSignal, session?: SessionRef): Promise<WorkerResult> {
    this.calls.push({ type, prompt, session });
    const output = this.outputs[type].shift()!;
    return typeof output === "string"
      ? { text: output, stdout: output, stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true }
      : output;
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
    const executor = new TaskExecutor(
      config,
      {
        key: "project-1",
        name: config.board.projects[0]!.name,
        goal: config.board.projects[0]!.goal,
        origin: "start",
      },
      graph,
      workers,
      federation,
      projectDir,
    );

    workers.outputs.supervise.push('{"kind":"hint","content":"Verify the result independently"}');
    await executor.supervise(project.id, "s1");
    workers.outputs.plan.push(`{"kind":"intents","intents":[{"from":[{"projectId":"${project.id}","factId":"origin","description":"start"}],"description":"Do the work"}]}`);
    await executor.plan(project.id, "p1");
    const intent = (await graph.getProject(project.id)).intents[0]!;
    writeFileSync(join(workspace, "report.md"), "details\n");
    workers.outputs.execute.push('{"kind":"fact","description":"Work completed","artifact":{"localPath":"report.md","mediaType":"text/markdown"}}');
    await executor.execute(project.id, intent, "e1");
    workers.outputs.plan.push(`{"kind":"complete","from":[{"projectId":"${project.id}","factId":"f001","description":"Work completed"}],"description":"Goal proven"}`);
    await executor.plan(project.id, "p2");

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    assert.equal(result.hints.length, 1);
    assert.equal(result.facts.find((fact) => fact.id === "f001")?.artifact?.mediaType, "text/markdown");
    const logs = readdirSync(join(projectDir, "logs"));
    assert.ok(logs.some((name) => /^graph-.*-supervise\.json$/.test(name)));
    const executeLog = logs.find((name) => /^graph-.*-execute\.json$/.test(name));
    assert.ok(executeLog);
    const executeContext = JSON.parse(readFileSync(join(projectDir, "logs", executeLog), "utf8")) as {
      assignment: { description: string }; current: { goal: string }; board: { projects: Array<{ goal: string }> };
    };
    assert.equal(executeContext.assignment.description, "Do the work");
    assert.equal(executeContext.current.goal, "done");
    assert.ok(executeContext.board.projects.some((item) => item.goal === "other project assignment"));
    const planLogs = logs.filter((name) => /^graph-.*-plan\.json$/.test(name)).sort();
    const finalPlan = JSON.parse(readFileSync(join(projectDir, "logs", planLogs.at(-1)!), "utf8")) as {
      frontier: { facts: Array<{ id: string }>; intents: Array<{ to: unknown }> };
      availableFactRefs: Array<{ projectId: string; factId: string; description: string }>;
    };
    assert.deepEqual(finalPlan.frontier.facts.map((fact) => fact.id), ["f001"]);
    assert.deepEqual(finalPlan.availableFactRefs, [{
      projectId: project.id, factId: "f001", description: "Work completed",
    }]);
    assert.equal(finalPlan.frontier.intents.length, 0);
    assert.equal(logs.some((name) => name.includes("output")), false);

    const supervisePrompt = workers.calls.find((call) => call.type === "supervise")!.prompt;
    const planPrompt = workers.calls.find((call) => call.type === "plan")!.prompt;
    const executePrompt = workers.calls.find((call) => call.type === "execute")!.prompt;
    assert.doesNotMatch(supervisePrompt, /skills?/i);
    assert.match(supervisePrompt, /origin and goal.*Fact–Intent DAG chains/s);
    assert.match(planPrompt, /Required Skills: \["review"\]/);
    assert.match(planPrompt, /exact immutable Fact description/);
    assert.match(executePrompt, /Required Skills: \["review"\]/);
    assert.doesNotMatch(`${planPrompt}${executePrompt}`, /\{skills\}/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Execute resumes a failed started worker through Finalize", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-execute-resume-"));
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
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, factId: "origin", description: "start" }],
      description: "Recover partial work",
      createdBy: "test",
    });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id), project.scope);
    const workers = new FakeWorkers();
    const resumeSession: SessionRef = { workerType: "pi", value: "session-1" };
    workers.outputs.execute.push(
      {
        text: "partial output",
        stdout: "partial output",
        stderr: "provider request failed",
        returncode: 1,
        timedOut: false,
        cancelled: false,
        started: true,
        session: resumeSession,
      },
      '{"kind":"fact","description":"Recovered confirmed result"}',
    );
    const config = configuration(root, workspace);
    const executor = new TaskExecutor(
      config,
      { key: "project-1", id: project.id, name: "P", goal: "done", origin: "start" },
      graph,
      workers,
      federation,
      join(projects, project.id),
    );

    await executor.execute(project.id, intent, "e-resume");

    const executeCalls = workers.calls.filter((call) => call.type === "execute");
    assert.equal(executeCalls.length, 2);
    assert.equal(executeCalls[0]!.session, undefined);
    assert.deepEqual(executeCalls[1]!.session, resumeSession);
    assert.match(executeCalls[1]!.prompt, /Required Skills: \["review"\]/);
    const result = await graph.getProject(project.id);
    assert.deepEqual(result.intents[0]!.to, {
      projectId: project.id, factId: "f001", description: "Recovered confirmed result",
    });
    assert.equal(result.facts.find((fact) => fact.id === "f001")?.description, "Recovered confirmed result");
    assert.ok(readdirSync(join(projects, project.id, "logs")).some((name) => /^graph-.*-finalize\.json$/.test(name)));
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function configuration(root: string, workspace: string): ResolvedTaskConfig {
  return {
    configPath: join(root, "task.json"), taskDir: root,
    board: {
      workspace,
      skills: ["review"],
      projects: [
        { name: "P", goal: "done" },
        { name: "Other", goal: "other project assignment" },
      ],
    },
    workers: { fake: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, args: [] } },
    scheduler: { maxConcurrent: 4, maxRunningProjects: 4, maxProjectConcurrent: 2, refillPerTick: 4, intervalMs: 10 },
    phase: { plan: { maxIntents: 3 }, supervise: { intervalMs: 1000 }, execute: { maxArtifactBytes: 1024 } },
  };
}
