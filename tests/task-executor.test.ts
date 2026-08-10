import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig, TaskType } from "../dist/utils/types.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GraphClient } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { TaskExecutor, type TaskWorkers } from "../dist/runtime/task-executor.js";
import type { SessionRef, WorkerResult } from "../dist/worker/types.js";

class FakeWorkers implements TaskWorkers {
  readonly outputs: Record<TaskType, Array<string | WorkerResult>> = { plan: [], supervise: [], execute: [] };
  readonly calls: Array<{ type: TaskType; prompt: string; timeout: number; cwd: string; session?: SessionRef; tmpDir?: string }> = [];
  pick(): string { return "fake"; }
  release(): void {}
  async execute(
    _name: string,
    type: TaskType,
    prompt: string,
    timeout: number,
    cwd: string,
    _signal?: AbortSignal,
    session?: SessionRef,
    options?: { tmpDir?: string },
  ): Promise<WorkerResult> {
    this.calls.push({ type, prompt, timeout, cwd, session, tmpDir: options?.tmpDir });
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

test("TaskExecutor.cleanupRuntimeTmp removes the per-Project runtime scratch directory (.tmp)", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-tmp-"));
  const projectDir = join(root, "project");
  const tmpDir = join(projectDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "pi-session.json"), "transient worker cache");
  const executor = new TaskExecutor(
    configuration(root),
    { key: "project-1", source: "start", goal: "done" },
    {} as never, {} as never, {} as never,
    projectDir, () => undefined, tmpDir,
  );
  assert.equal(existsSync(tmpDir), true, ".tmp exists before cleanup");
  executor.cleanupRuntimeTmp();
  assert.equal(existsSync(tmpDir), false, ".tmp removed after cleanup");
  // Idempotent: a second cleanup on a missing directory is a no-op.
  executor.cleanupRuntimeTmp();
});

test("built-in phase prompts stay concise and leave judgment to the AI", () => {
  for (const name of ["plan.md", "supervise.md", "execute.md", "execute-finalize.md"]) {
    const prompt = readFileSync(join("dist", "runtime", "prompts", name), "utf8");
    assert.ok(Buffer.byteLength(prompt, "utf8") < 1_500, `${name} should remain under 1500 bytes`);
  }
});

test("Plan, Supervise and Execute mutate Graph only through HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-task-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl, { projectsRoot: projects });
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const projectDir = join(projects, project.id);
    const federation = new FederationBus();
    federation.register(project.id, projectDir, project.scope);
    const external = await graph.createProject({ title: "External", target: "external evidence", goal: "external goal", scope: "s" });
    federation.register(external.id, join(projects, external.id), external.scope);
    const externalIntent = await graph.createIntent(external.id, {
      from: [{ projectId: external.id, id: "origin", description: "external evidence" }],
      description: "Verify external evidence", createdBy: "test",
    });
    await graph.conclude(external.id, externalIntent.id, { description: "external verified", artifact: null, concludedBy: "test" });
    await graph.putPathAbstract(external.id, "f0001", {
      factRef: { projectId: external.id, id: "f0001", description: "external verified" },
      pathOverview: "external path summary", verifiedCore: ["external verified"],
    });
    federation.publishPath({
      projectId: external.id,
      leaf: { projectId: external.id, id: "f0001", description: "external verified" },
      pathAbs: "artifacts/path_abs_f0001",
      segments: [[
        { projectId: external.id, id: "origin", description: "external evidence" },
        { projectId: external.id, id: "f0001", description: "external verified" },
      ]],
    });
    const workers = new FakeWorkers();
    const config = configuration(root);
    const executor = new TaskExecutor(
      config,
      {
        key: "project-1",
        source: config.board.projects[0]!.source,
        goal: config.board.projects[0]!.goal,
      },
      graph,
      workers,
      federation,
      projectDir,
    );

    workers.outputs.supervise.push('{"kind":"hint","content":"Verify the result independently"}');
    await executor.supervise(project.id, "s1");
    workers.outputs.plan.push(`{"kind":"intents","intents":[{"from":[{"projectId":"${project.id}","id":"origin","description":"start"}],"hintIds":["h0001"],"customProfile":"Use for primary research.","description":"Do the work"}]}`);
    await executor.plan(project.id, "p1");
    const intent = (await graph.getProject(project.id)).intents[0]!;
    workers.outputs.execute.push('{"kind":"fact","description":"Work completed","artifact":{"filename":"report.md","mediaType":"text/markdown","content":"details\\n"}}');
    await executor.execute(project.id, intent, "e1");
    // Execute does not broadcast: the pre-Plan hook (syncPaths) generates the
    // analysis summary and publishes the Path before the next Plan runs.
    workers.outputs.plan.push('{"pathOverview":"origin to Work completed: the assigned work is done","verifiedCore":["the assigned work is done"]}');
    workers.outputs.plan.push(`{"kind":"complete","from":[{"projectId":"${project.id}","id":"f0001","description":"Work completed"}],"description":"Goal proven"}`);
    await executor.plan(project.id, "p2");

    // The conclusion was broadcast to the same-scope external Project as a Path.
    const broadcast = federation.pendingPathsFor(external.id);
    assert.equal(broadcast.length, 1);
    assert.deepEqual(broadcast[0]!.leaf, { projectId: project.id, id: "f0001", description: "Work completed" });
    assert.equal(broadcast[0]!.pathAbs, "artifacts/path_abs_f0001");
    assert.deepEqual(broadcast[0]!.segments, [[
      { projectId: project.id, id: "origin", description: "start" },
      { projectId: project.id, id: "f0001", description: "Work completed" },
    ]]);
    // The analysis result is persisted at the deterministic Path Abstract path.
    const pathInfo = await graph.getPathAbstract(project.id, "f0001");
    assert.equal(pathInfo.pathOverview, "origin to Work completed: the assigned work is done");
    assert.equal(existsSync(join(projectDir, "artifacts", "path_abs_f0001")), true);

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    assert.equal(readFileSync(join(projectDir, "out", "report.md"), "utf8"), "details\n", "final deliverable materialized under the Project out directory");
    assert.equal(result.hints.length, 1);
    assert.equal("kind" in result.hints[0]!, false);
    assert.equal(result.hints[0]?.consumedByIntentId, intent.id);
    assert.equal(intent.customProfile, "Use for primary research.");
    assert.match(intent.customProfileDigest!, /^[0-9a-f]{16}$/);
    assert.equal("customProfile" in result.facts.find((fact) => fact.id === "f0001")!, false);
    assert.equal(result.facts.find((fact) => fact.id === "f0001")?.artifact?.mediaType, "text/markdown");
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
        projects: Record<string, {
          source: { projectId: string; id: string; description: string };
          goal: { projectId: string; id: string; description: string };
          leafFacts: Array<{ ref: { projectId: string; id: string; description: string }; fact: { id: string } }>;
          openIntents: Array<{ to: unknown }>;
          unconsumedHints: Array<{ id: string }>;
        }>;
        external: Array<{ factRef: { projectId: string; id: string; description: string }; pathAbs: { inputPath: string; readOnly: boolean } }>;
        truncated: boolean;
        omitted: Record<string, number>;
      };
    });
    const initialPlan = plans.find((snapshot) => snapshot.executionId === "p1")!;
    const finalPlan = plans.find((snapshot) => snapshot.executionId === "p2")!;
    const initialProject = initialPlan.context.projects[project.id]!;
    const finalProject = finalPlan.context.projects[project.id]!;
    assert.deepEqual(Object.keys(initialPlan.context.projects), [project.id]);
    assert.equal("title" in initialProject, false, "Plan current Project omits the source-duplicate title");
    assert.deepEqual(initialProject.source, { projectId: project.id, id: "origin", description: "start" });
    assert.deepEqual(initialProject.goal, { projectId: project.id, id: "goal", description: "done" });
    assert.deepEqual(initialProject.leafFacts.map((source) => source.ref), [
      { projectId: project.id, id: "origin", description: "start" },
    ]);
    assert.deepEqual(initialProject.unconsumedHints.map((hint) => hint.id), ["h0001"]);
    assert.deepEqual(initialPlan.context.external.map((item) => item.factRef), [
      { projectId: external.id, id: "f0001", description: "external verified" },
    ]);
    assert.equal(initialPlan.context.external[0]!.pathAbs.readOnly, true);
    assert.match(initialPlan.context.external[0]!.pathAbs.inputPath, /path_abs_f0001$/);
    assert.deepEqual(finalProject.leafFacts.map((source) => source.ref), [
      { projectId: project.id, id: "f0001", description: "Work completed" },
    ]);
    assert.equal(finalProject.openIntents.length, 0);
    assert.equal(finalProject.unconsumedHints.length, 0);
    assert.equal(finalPlan.context.truncated, false);
    assert.equal(logs.some((name) => name.includes("output")), false);

    const workerTmp = join(projectDir, ".tmp");
    assert.ok(workers.calls.length > 0);
    assert.ok(workers.calls.every((call) => call.cwd === workerTmp), "every Worker phase runs from the Project .tmp directory");
    assert.ok(workers.calls.every((call) => call.tmpDir === workerTmp), "protocol scratch path matches the Worker cwd");
    assert.equal(workers.calls.find((call) => call.prompt.startsWith("# Analyze"))?.timeout, 300_000);
    assert.equal(existsSync(workerTmp), true);

    const supervisePrompt = workers.calls.find((call) => call.type === "supervise")!.prompt;
    const planPrompt = workers.calls.find((call) => call.type === "plan")!.prompt;
    const executePrompt = workers.calls.find((call) => call.type === "execute")!.prompt;
    assert.doesNotMatch(supervisePrompt, /skills?/i);
    assert.match(supervisePrompt, /Independently judge/);
    assert.match(planPrompt, /Available Skills:[\s\S]*"review"/);
    assert.match(planPrompt, /copy every selected reference exactly/);
    assert.match(planPrompt, /Exercise independent judgment/);
    assert.doesNotMatch(planPrompt, /\nSource:\n|\nGoal:\n/);
    assert.doesNotMatch(planPrompt, /Origin:/);
    assert.match(executePrompt, /Available Skills:[\s\S]*"review"/);
    assert.match(supervisePrompt, /Use for proof review/);
    assert.match(supervisePrompt, /Review the entire proof carefully/);
    assert.match(planPrompt, /Use for security planning/);
    assert.match(planPrompt, /Plan every proof edge/);
    assert.match(planPrompt, /Use for primary research/);
    assert.match(executePrompt, /Use for primary research/);
    assert.match(executePrompt, /Collect primary evidence only/);
    assert.match(executePrompt, /"artifact":null/);
    assert.doesNotMatch(`${planPrompt}${executePrompt}`, /\{skills\}/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Plan retains independent judgment when no Skill is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-plan-no-skill-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({
      title: "Unfamiliar domain",
      target: "No analysis has been performed",
      goal: "Produce a defensible analysis of the assigned problem",
    });
    const config = configuration(root);
    config.board.skills = [];
    config.phase.plan.customProfile = undefined;
    config.phase.execute.customProfile = [];
    const workers = new FakeWorkers();
    workers.outputs.plan.push('{"kind":"noop"}');
    const executor = new TaskExecutor(
      config,
      { key: "project-1", source: "No analysis has been performed", goal: config.board.projects[0]!.goal },
      graph,
      workers,
      new FederationBus(),
      join(projects, project.id),
    );

    await executor.plan(project.id, "p-no-skill");

    const prompt = workers.calls[0]!.prompt;
    assert.match(prompt, /Available Skills:\s*\[\]/);
    assert.match(prompt, /Exercise independent judgment/);
    assert.ok(prompt.length < 4_000, "built-in Plan instructions stay concise");
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
      from: [{ projectId: project.id, id: "origin", description: "start" }],
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
    workers.outputs.plan.push('{"pathOverview":"origin to Recovered confirmed result","verifiedCore":["Recovered confirmed result"]}');
    const executor = new TaskExecutor(
      config,
      { key: "project-1", id: project.id, source: "start", goal: "done" },
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
    assert.match(executeCalls[1]!.prompt, /Convert the bound Execute's existing work into one valid Fact/i);
    assert.match(executeCalls[1]!.prompt, /"executionId": "e-resume"/);
    const result = await graph.getProject(project.id);
    assert.deepEqual(result.intents[0]!.to, {
      projectId: project.id, id: "f0001", description: "Recovered confirmed result",
    });
    assert.equal(result.intents[0]!.concludedBy, "finalize:e-resume");
    assert.equal(result.facts.find((fact) => fact.id === "f0001")?.description, "Recovered confirmed result");
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
  const graph = new GraphClient(server.baseUrl, { projectsRoot: projects });
  try {
    const project = await graph.createProject({ title: "P", target: "immutable source", goal: "done" });
    const sourcePath = join(root, "source.md");
    writeFileSync(sourcePath, "immutable source details\n");
    const sourceArtifact = await graph.uploadArtifact(project.id, sourcePath, "text/markdown");
    const sourceIntent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "immutable source" }],
      description: "Materialize one source file", createdBy: "test",
    });
    const source = await graph.conclude(project.id, sourceIntent.id, {
      description: "Immutable source file", artifact: sourceArtifact, concludedBy: "test",
    });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: source.fact.id, description: source.fact.description }],
      description: "Attempt mutation", createdBy: "test",
    });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id));
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, source: "immutable source", goal: "done" },
      graph,
      new SourceMutatingWorkers(),
      federation,
      join(projects, project.id),
    );

    await assert.rejects(executor.execute(project.id, intent, "e-tamper"), /Artifact size or type mismatch|Artifact hash mismatch/);
    const result = await graph.getProject(project.id);
    assert.equal(result.intents[1]?.to, null);
    assert.deepEqual(result.facts.map((fact) => fact.id).sort(), ["f0001", "goal", "origin"]);
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
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      customProfile: "Use for primary research.",
      customProfileDigest: "0000000000000000",
      description: "Research", createdBy: "test",
    });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id));
    const workers = new FakeWorkers();
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, source: "start", goal: "done" },
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

test("Plan and Supervise retry transient worker and malformed-output failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-phase-retry-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id), project.scope);
    const workers = new FakeWorkers();
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", source: "start", goal: "done" },
      graph,
      workers,
      federation,
      join(projects, project.id),
    );

    // Supervise: malformed JSON on the first attempt, valid output on retry.
    workers.outputs.supervise.push(
      "not json at all {",
      '{"kind":"hint","content":"Verify independently"}',
    );
    await executor.supervise(project.id, "s-retry");
    assert.equal(workers.calls.filter((call) => call.type === "supervise").length, 2);
    assert.equal((await graph.getProject(project.id)).hints.length, 1);

    // Supervise: failed started worker on the first attempt, noop on retry.
    workers.outputs.supervise.push(
      { text: "", stdout: "", stderr: "provider request failed", returncode: 1, timedOut: false, cancelled: false, started: true },
      '{"kind":"noop"}',
    );
    await executor.supervise(project.id, "s-retry2");
    assert.equal(workers.calls.filter((call) => call.type === "supervise").length, 4);
    assert.equal((await graph.getProject(project.id)).hints.length, 1);

    // Supervise: an attempt that never started is not retried.
    workers.outputs.supervise.push(
      { text: "", stdout: "", stderr: "worker config error", returncode: 1, timedOut: false, cancelled: false, started: false },
    );
    await assert.rejects(executor.supervise(project.id, "s-no-retry"), /supervise worker failed/);
    assert.equal(workers.calls.filter((call) => call.type === "supervise").length, 5);

    // Plan: malformed output on the first attempt, valid intents on retry.
    workers.outputs.plan.push(
      '{"kind":"intents","intents":[{"from":[{"projectId":"origin"',
      `{"kind":"intents","intents":[{"from":[{"projectId":"${project.id}","id":"origin","description":"start"}],"hintIds":[],"customProfile":null,"description":"Do the work"}]}`,
    );
    await executor.plan(project.id, "p-retry");
    const planCalls = workers.calls.filter((call) => call.type === "plan");
    assert.equal(planCalls.length, 2);
    assert.equal(planCalls[1]!.prompt, planCalls[0]!.prompt, "retry reuses the same rendered prompt");
    assert.equal((await graph.getProject(project.id)).intents.length, 1);

    // Every retry is recorded in the Project's main.log alongside Graph events.
    const log = readFileSync(join(projects, project.id, "logs", "main.log"), "utf8");
    const retries = log.split(/\r?\n/).filter((line) => line.includes('"phase_retry"'));
    assert.ok(retries.length >= 3, `phase_retry events recorded in main.log, got ${retries.length}`);
    for (const line of retries) {
      const event = JSON.parse(line) as { projectId: string; phase: string; attempt: number; message: string };
      assert.equal(event.projectId, project.id);
      assert.ok(["plan", "supervise"].includes(event.phase));
      assert.ok(event.attempt >= 1);
      assert.ok(event.message.length > 0);
    }
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncPaths caches deterministic Path Abstracts and never re-runs the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-analyze-cache-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      description: "Do the work", createdBy: "test",
    });
    await graph.conclude(project.id, intent.id, { description: "Work completed", artifact: null, concludedBy: "test" });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id), project.scope);
    const workers = new FakeWorkers();
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, source: "start", goal: "done" },
      graph,
      workers,
      federation,
      join(projects, project.id),
    );

    workers.outputs.plan.push('{"pathOverview":"cached analysis","verifiedCore":["Work completed"]}');
    await executor.syncPaths(project.id);
    const dispatches = workers.calls.filter((call) => call.type === "plan").length;
    assert.equal(dispatches, 1);

    await executor.syncPaths(project.id);
    assert.equal(workers.calls.filter((call) => call.type === "plan").length, dispatches, "cached Path Abstract: no worker dispatch");
    const info = await graph.getPathAbstract(project.id, "f0001");
    assert.equal(info.pathOverview, "cached analysis");
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncPaths falls back to a description join when the worker keeps failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-analyze-fallback-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      description: "Do the work", createdBy: "test",
    });
    await graph.conclude(project.id, intent.id, { description: "Work completed", artifact: null, concludedBy: "test" });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id), project.scope);
    const workers = new FakeWorkers();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      workers.outputs.plan.push({ text: "", stdout: "", stderr: "provider down", returncode: 1, timedOut: false, cancelled: false, started: true });
    }
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, source: "start", goal: "done" },
      graph,
      workers,
      federation,
      join(projects, project.id),
    );

    await executor.syncPaths(project.id);
    assert.equal(workers.calls.filter((call) => call.type === "plan").length, 3, "all analysis attempts exhausted before the fallback");
    // The fallback is persisted too, so the failure is not retried on every restart.
    const info = await graph.getPathAbstract(project.id, "f0001");
    assert.equal(info.pathOverview, "start → Work completed");
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncPaths persists structured Path Abstract content", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-analyze-cap-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      description: "Do the work", createdBy: "test",
    });
    await graph.conclude(project.id, intent.id, { description: "Work completed", artifact: null, concludedBy: "test" });
    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id), project.scope);
    const workers = new FakeWorkers();
    workers.outputs.plan.push(JSON.stringify({ pathOverview: "start to verified result", verifiedCore: ["core one", "core two"] }));
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, source: "start", goal: "done" },
      graph,
      workers,
      federation,
      join(projects, project.id),
    );

    await executor.syncPaths(project.id);
    const abstract = await graph.getPathAbstract(project.id, "f0001");
    assert.equal(abstract.pathOverview, "start to verified result");
    assert.deepEqual(abstract.verifiedCore, ["core one", "core two"]);
    assert.deepEqual(JSON.parse(readFileSync(join(projects, project.id, "artifacts", "path_abs_f0001"), "utf8")), abstract);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Analyze builds Fact n from its direct predecessor path_abs description", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-analyze-chain-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({ title: "P", target: "start", goal: "done", scope: "s" });
    const first = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      description: "First step", createdBy: "test",
    });
    await graph.conclude(project.id, first.id, { description: "First verified", artifact: null, concludedBy: "test" });
    const second = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "f0001", description: "First verified" }],
      description: "Second step", createdBy: "test",
    });
    await graph.conclude(project.id, second.id, { description: "Second verified", artifact: null, concludedBy: "test" });

    const federation = new FederationBus();
    federation.register(project.id, join(projects, project.id), project.scope);
    const workers = new FakeWorkers();
    workers.outputs.plan.push('{"pathOverview":"start to first","verifiedCore":["first core"]}');
    workers.outputs.plan.push('{"pathOverview":"start through first to second","verifiedCore":["first core","second core"]}');
    const executor = new TaskExecutor(
      configuration(root),
      { key: "project-1", id: project.id, source: "start", goal: "done" },
      graph, workers, federation, join(projects, project.id),
    );

    await executor.syncPaths(project.id);
    const analyzeCalls = workers.calls.filter((call) => call.type === "plan");
    assert.equal(analyzeCalls.length, 2);
    assert.equal(analyzeCalls[0]!.timeout, 300_000);
    assert.equal(analyzeCalls[1]!.timeout, 300_000);
    assert.match(analyzeCalls[1]!.prompt, /path_abs_f0001/);
    assert.match(analyzeCalls[1]!.prompt, /start to first/);
    assert.match(analyzeCalls[1]!.prompt, /First verified/);
    const current = await graph.getPathAbstract(project.id, "f0002");
    assert.equal(current.pathOverview, "start through first to second");
    assert.deepEqual(current.verifiedCore, ["first core", "second core"]);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A worker that simulates a concurrent Execute consuming the current leaf
 * while Plan is thinking, then returns a stale Plan rooted at that leaf. */
class StaleInjectingWorkers implements TaskWorkers {
  planCalls = 0;
  private readonly graph: GraphClient;
  private readonly projectId: string;
  private readonly f002: string;
  constructor(graph: GraphClient, projectId: string, f002: string) {
    this.graph = graph;
    this.projectId = projectId;
    this.f002 = f002;
  }
  pick(): string { return "fake"; }
  release(): void {}
  async execute(_name: string, type: TaskType): Promise<WorkerResult> {
    if (type !== "plan") throw new Error(`unexpected worker type ${type}`);
    this.planCalls += 1;
    if (this.planCalls === 1) {
      // A concurrent Execute concludes f0001 -> f0002 while Plan is thinking,
      // then Plan returns an Intent still rooted at the now-superseded f0001.
      const concurrent = await this.graph.createIntent(this.projectId, {
        from: [{ projectId: this.projectId, id: "f0001", description: "Work completed" }],
        hintIds: [], description: "concurrent consume", createdBy: "concurrent",
      });
      await this.graph.conclude(this.projectId, concurrent.id, { description: this.f002, artifact: null, concludedBy: "concurrent" });
      return this.intent("f0001", "Work completed", "stale intent from a consumed leaf");
    }
    return this.intent("f0002", this.f002, "valid intent from the current leaf");
  }
  private intent(id: string, description: string, intentDescription: string): WorkerResult {
    const output = JSON.stringify({
      kind: "intents",
      intents: [{ from: [{ projectId: this.projectId, id, description }], hintIds: [], customProfile: null, description: intentDescription }],
    });
    return { text: output, stdout: output, stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true };
  }
}

test("Plan re-plans instead of failing when a concurrent Execute consumes a source leaf", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-stale-"));
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
    const config = configuration(root);
    const projectConfig = { key: "project-1", source: config.board.projects[0]!.source, goal: config.board.projects[0]!.goal };

    // Establish the current leaf f0001 ("Work completed") through a normal round.
    const seed = new FakeWorkers();
    const seedExecutor = new TaskExecutor(config, projectConfig, graph, seed, federation, projectDir);
    seed.outputs.plan.push(`{"kind":"intents","intents":[{"from":[{"projectId":"${project.id}","id":"origin","description":"start"}],"hintIds":[],"customProfile":null,"description":"Do the work"}]}`);
    await seedExecutor.plan(project.id, "p1");
    const firstIntent = (await graph.getProject(project.id)).intents[0]!;
    seed.outputs.execute.push('{"kind":"fact","description":"Work completed","artifact":null}');
    await seedExecutor.execute(project.id, firstIntent, "e1");
    // Generate f0001's path_abs up front so the re-plan's pre-Plan hook
    // hits the cache and never touches the stale-injecting worker.
    seed.outputs.plan.push('{"pathOverview":"origin to Work completed","verifiedCore":["Work completed"]}');
    await seedExecutor.syncPaths(project.id);

    const f002 = "Deeper analysis built on the completed work";
    const workers = new StaleInjectingWorkers(graph, project.id, f002);
    const executor = new TaskExecutor(config, projectConfig, graph, workers, federation, projectDir);
    await executor.plan(project.id, "p2");

    assert.equal(workers.planCalls, 2, "Plan retried once after its source leaf was consumed mid-flight");
    const after = await graph.getProject(project.id);
    const replanned = after.intents.find((intent) => intent.createdBy === "plan:p2");
    assert.ok(replanned, "the re-planned Intent was persisted");
    assert.deepEqual(replanned!.from, [{ projectId: project.id, id: "f0002", description: f002 }]);
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
        { source: "start", goal: "done" },
        { source: "other source", goal: "other project assignment" },
      ],
    },
    workers: { fake: { type: "pi", taskTypes: ["plan", "supervise", "execute"], maxRunning: 1, priority: 1, env: {} } },
    scheduler: { maxRunningProjects: 4, intervalMs: 10 },
    phase: {
      plan: {
        customProfile: { description: "Use for security planning.", prompt: "Plan every proof edge." },
      },
      supervise: {
        intervalMs: 1000,
        customProfile: { description: "Use for proof review.", prompt: "Review the entire proof carefully" },
      },
      execute: {
        maxArtifactBytes: 1024,
        customProfile: [{ description: "Use for primary research.", prompt: "Collect primary evidence only" }],
      },
    },
  };
}
