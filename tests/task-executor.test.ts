import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  release(): void {}
  async execute(_name: string, type: TaskType, prompt: string, _timeout: number, _cwd: string, _signal?: AbortSignal, session?: SessionRef): Promise<WorkerResult> {
    this.calls.push({ type, prompt, session });
    const output = this.outputs[type].shift()!;
    return typeof output === "string"
      ? { text: output, stdout: output, stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true }
      : output;
  }
}

class SourceMutatingWorkers implements TaskWorkers {
  pick(): string { return "fake"; }
  release(): void {}
  async execute(_name: string, type: TaskType, prompt: string): Promise<WorkerResult> {
    assert.equal(type, "execute");
    const encodedPath = /"inputPath":\s*("(?:\\.|[^"\\])*")/.exec(prompt)?.[1];
    assert.ok(encodedPath, "Execute prompt must contain a source inputPath");
    const inputPath = JSON.parse(encodedPath) as string;
    chmodSync(inputPath, 0o666);
    writeFileSync(inputPath, "tampered source\n");
    return {
      text: '{"kind":"fact","description":"Must not persist","artifact":{"filename":"result.md","mediaType":"text/markdown","content":"x"}}',
      stdout: "", stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true,
    };
  }
}

test("Plan, Supervise and Execute mutate Graph only through HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-task-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
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
    const config = configuration(root);
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
    workers.outputs.plan.push(`{"kind":"intents","intents":[{"from":[{"projectId":"${project.id}","factId":"origin","description":"start"}],"hintIds":["h001"],"customProfile":"Use for primary research.","description":"Do the work"}]}`);
    await executor.plan(project.id, "p1");
    const intent = (await graph.getProject(project.id)).intents[0]!;
    workers.outputs.execute.push('{"kind":"fact","description":"Work completed","artifact":{"filename":"report.md","mediaType":"text/markdown","content":"details\\n"}}');
    await executor.execute(project.id, intent, "e1");
    workers.outputs.plan.push(`{"kind":"complete","from":[{"projectId":"${project.id}","factId":"f001","description":"Work completed"}],"description":"Goal proven"}`);
    await executor.plan(project.id, "p2");

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    assert.equal(readFileSync(join(root, "report.md"), "utf8"), "details\n", "final deliverable materialized next to task.json");
    assert.equal(result.hints.length, 1);
    assert.equal("kind" in result.hints[0]!, false);
    assert.equal(result.hints[0]?.consumedByIntentId, intent.id);
    assert.equal(intent.customProfile, "Use for primary research.");
    assert.match(intent.customProfileDigest!, /^[0-9a-f]{16}$/);
    assert.equal("customProfile" in result.facts.find((fact) => fact.id === "f001")!, false);
    assert.equal(result.facts.find((fact) => fact.id === "f001")?.artifact?.mediaType, "text/markdown");
    const logs = readdirSync(join(projectDir, "logs"));
    assert.ok(logs.some((name) => /^graph-.*-supervise\.json$/.test(name)));
    const executeLog = logs.find((name) => /^graph-.*-execute\.json$/.test(name));
    assert.ok(executeLog);
    const executeSnapshot = JSON.parse(readFileSync(join(projectDir, "logs", executeLog), "utf8")) as {
      context: {
        project: { title: string };
        intent: { description: string };
        sources: Array<{ fact: { artifact: { inputPath: string; readOnly: boolean } | null } }>;
        truncated: boolean;
        omitted: { sources: number };
      };
      customProfile: { description: string; digest: string };
      executionId: string;
      at: string;
    };
    assert.equal(executeSnapshot.context.intent.description, "Do the work");
    assert.equal(executeSnapshot.context.project.title, "P");
    assert.equal(executeSnapshot.customProfile.description, "Use for primary research.");
    assert.match(executeSnapshot.customProfile.digest, /^[0-9a-f]{16}$/);
    assert.equal(executeSnapshot.executionId, "e1");
    assert.match(executeSnapshot.at, /^\d{8}T\d{6}\.\d{3}$/);
    assert.equal(executeSnapshot.context.sources[0]?.fact.artifact, null);
    assert.equal(executeSnapshot.context.truncated, false);
    assert.equal(executeSnapshot.context.omitted.sources, 0);
    assert.doesNotMatch(JSON.stringify(executeSnapshot), /Collect primary evidence only|other project assignment/);
    const planLogs = logs.filter((name) => /^graph-.*-plan\.json$/.test(name)).sort();
    const plans = planLogs.map((name) => JSON.parse(readFileSync(join(projectDir, "logs", name), "utf8")) as {
      executionId: string;
      context: {
        source: { id: string; description: string; artifact: null };
        goal: { id: string; description: string; artifact: null };
        leafFacts: Array<{ id: string }>;
        openIntents: Array<{ to: unknown }>;
        unconsumedHints: Array<{ id: string }>;
        truncated: boolean;
        omitted: Record<string, number>;
      };
    });
    const initialPlan = plans.find((snapshot) => snapshot.executionId === "p1")!;
    const finalPlan = plans.find((snapshot) => snapshot.executionId === "p2")!;
    assert.equal(initialPlan.context.source.id, "origin");
    assert.equal(initialPlan.context.source.description, "start");
    assert.equal(initialPlan.context.source.artifact, null);
    assert.equal(initialPlan.context.goal.id, "goal");
    assert.deepEqual(initialPlan.context.leafFacts.map((fact) => fact.id), ["origin"]);
    assert.deepEqual(initialPlan.context.unconsumedHints.map((hint) => hint.id), ["h001"]);
    assert.deepEqual(finalPlan.context.leafFacts.map((fact) => fact.id), ["f001"]);
    assert.equal(finalPlan.context.openIntents.length, 0);
    assert.equal(finalPlan.context.unconsumedHints.length, 0);
    assert.equal(finalPlan.context.truncated, false);
    assert.equal(logs.some((name) => name.includes("output")), false);

    const supervisePrompt = workers.calls.find((call) => call.type === "supervise")!.prompt;
    const planPrompt = workers.calls.find((call) => call.type === "plan")!.prompt;
    const executePrompt = workers.calls.find((call) => call.type === "execute")!.prompt;
    assert.doesNotMatch(supervisePrompt, /skills?/i);
    assert.match(supervisePrompt, /Review the current Project proof state/);
    assert.match(planPrompt, /Available Skills:[\s\S]*"review"/);
    assert.match(planPrompt, /Do not invent or rewrite references/);
    assert.match(planPrompt, /immutable DAG whose current state is its complete leaf frontier/);
    assert.match(planPrompt, /## Source/);
    assert.doesNotMatch(planPrompt, /## Origin/);
    assert.match(executePrompt, /Available Skills:[\s\S]*"review"/);
    assert.match(supervisePrompt, /Use for proof review/);
    assert.match(supervisePrompt, /Review the entire proof carefully/);
    assert.match(planPrompt, /Use for security planning/);
    assert.match(planPrompt, /Plan every proof edge/);
    assert.match(planPrompt, /Use for primary research/);
    assert.match(executePrompt, /Use for primary research/);
    assert.match(executePrompt, /Collect primary evidence only/);
    assert.match(executePrompt, /artifact: null/);
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
  mkdirSync(projects, { recursive: true });
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
      '{"kind":"fact","description":"Recovered confirmed result","artifact":{"filename":"recovered.md","mediaType":"text/markdown","content":"Recovered confirmed result\\n"}}',
    );
    const config = configuration(root);
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
    assert.match(executeCalls[1]!.prompt, /Available Skills:[\s\S]*"review"/);
    assert.match(executeCalls[1]!.prompt, /bound Execute started but did not return an acceptable strict result/i);
    assert.match(executeCalls[1]!.prompt, /"executionId": "e-resume"/);
    const result = await graph.getProject(project.id);
    assert.deepEqual(result.intents[0]!.to, {
      projectId: project.id, factId: "f001", description: "Recovered confirmed result",
    });
    assert.equal(result.intents[0]!.concludedBy, "finalize:e-resume");
    assert.equal(result.facts.find((fact) => fact.id === "f001")?.description, "Recovered confirmed result");
    const finalizeLog = readdirSync(join(projects, project.id, "logs")).find((name) => /^graph-.*-finalize\.json$/.test(name));
    assert.ok(finalizeLog);
    const finalizeSnapshot = JSON.parse(readFileSync(join(projects, project.id, "logs", finalizeLog), "utf8")) as {
      executionId: string; boundExecutionId: string;
    };
    assert.equal(finalizeSnapshot.executionId, "e-resume");
    assert.equal(finalizeSnapshot.boundExecutionId, "e-resume");
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Execute rejects a source Artifact changed by the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-source-integrity-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "immutable source", goal: "done" });
    const sourcePath = join(root, "source.md");
    writeFileSync(sourcePath, "immutable source details\n");
    const sourceArtifact = await graph.uploadArtifact(project.id, sourcePath, "text/markdown");
    const sourceIntent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, factId: "origin", description: "immutable source" }],
      description: "Materialize one source file", createdBy: "test",
    });
    const source = await graph.conclude(project.id, sourceIntent.id, {
      description: "Immutable source file", artifact: sourceArtifact, concludedBy: "test",
    });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, factId: source.fact.id, description: source.fact.description }],
      description: "Attempt mutation", createdBy: "test",
    });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id));
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, name: "P", goal: "done", origin: "immutable source" },
      graph,
      new SourceMutatingWorkers(),
      federation,
      join(projects, project.id),
    );

    await assert.rejects(executor.execute(project.id, intent, "e-tamper"), /Artifact size or type mismatch|Artifact hash mismatch/);
    const result = await graph.getProject(project.id);
    assert.equal(result.intents[1]?.to, null);
    assert.deepEqual(result.facts.map((fact) => fact.id).sort(), ["f001", "goal", "origin"]);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Execute rejects custom profile configuration drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-profile-drift-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done" });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, factId: "origin", description: "start" }],
      customProfile: "Use for primary research.",
      customProfileDigest: "0000000000000000",
      description: "Research", createdBy: "test",
    });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id));
    const workers = new FakeWorkers();
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, name: "P", goal: "done", origin: "start" },
      graph,
      workers,
      federation,
      join(projects, project.id),
    );

    await assert.rejects(executor.execute(project.id, intent, "e-drift"), /customProfile digest mismatch/);
    assert.equal(workers.calls.length, 0);
    assert.equal((await graph.getProject(project.id)).intents[0]?.to, null);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function configuration(root: string): ResolvedTaskConfig {
  return {
    configPath: join(root, "task.json"), taskDir: root,
    board: {
      skills: ["review"],
      projects: [
        { name: "P", goal: "done" },
        { name: "Other", goal: "other project assignment" },
      ],
    },
    workers: { fake: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, args: [] } },
    scheduler: { maxConcurrent: 4, maxRunningProjects: 4, maxProjectConcurrent: 2, refillPerTick: 4, intervalMs: 10 },
    phase: {
      plan: {
        maxIntents: 3,
        customProfile: { description: "Use for security planning.", prompt: "Plan every proof edge." },
      },
      supervise: {
        intervalMs: 1000,
        customProfile: { description: "Use for proof review.", prompt: "Review the entire proof carefully" },
      },
      execute: {
        maxArtifactBytes: 1024,
        customProfiles: [{ description: "Use for primary research.", prompt: "Collect primary evidence only" }],
      },
    },
  };
}
