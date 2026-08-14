import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig } from "../../dist/utils/types.js";
import { AgentRuntime } from "../../dist/runtime/agent-runtime.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";
import { GraphClient } from "../../dist/graph/graph-client.js";

function configuration(root: string): ResolvedTaskConfig {
  return {
    configPath: join(root, "task.json"), taskDir: root,
    board: { skills: [], projects: [{ source: "start", goal: "done" }] },
    // claude-code is not installed here, so any scheduler dispatch fails fast
    // (spawn ENOENT -> phase_failed) without invoking a real CLI.
    workers: {
      planner: { type: "claude-code", taskTypes: ["plan", "supervise"], maxRunning: 1, priority: 1, env: {} },
      executor: { type: "claude-code", taskTypes: ["execute"], maxRunning: 1, priority: 1, env: {} },
    },
    scheduler: { maxRunningProjects: 1, intervalMs: 3_000 },
    phase: { plan: {}, supervise: { intervalMs: 60_000 }, execute: { maxArtifactBytes: 1024, customProfile: [] } },
  };
}

test("a Runtime started against a completed Project releases its execution target on the first tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-runtime-release-"));
  const projectsRoot = join(root, "projects");
  const registry = new ProjectStoreRegistry(projectsRoot);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl, { projectsRoot });
  let runtime: AgentRuntime | undefined;
  try {
    const project = await graph.createProject({ title: "done", target: "start", goal: "done" });
    const intent = await graph.createIntent(project.id, {
      from: [{ projectId: project.id, id: "origin", description: "start" }],
      description: "produce the evidence", createdBy: "test",
    });
    const concluded = await graph.conclude(project.id, intent.id, { description: "evidence", artifact: null, concludedBy: "test" });
    await graph.complete(project.id, {
      from: [{ projectId: project.id, id: concluded.fact.id, description: concluded.fact.description }],
      description: "goal proven", completedBy: "test",
    });

    const config = configuration(root);
    config.board.projects[0]!.id = project.id;
    runtime = new AgentRuntime(config, { graphUrl: server.baseUrl, projectsRoot, installSkills: false });
    await runtime.start();
    // The first scheduler tick observes the completed status and releases the
    // execution target; the audit event lands asynchronously after start().
    const logPath = join(projectsRoot, project.id, "logs", "main.log");
    const deadline = Date.now() + 5_000;
    let released = false;
    while (Date.now() < deadline) {
      if (existsSync(logPath) && readFileSync(logPath, "utf8").includes('"type":"execution_target_released"')) { released = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(released, "execution_target_released is written once the completed Project is observed");
    const log = readFileSync(logPath, "utf8");
    assert.match(log, new RegExp(`"projectId":"${project.id}"`));
    assert.match(log, /"mode":"local"/);
    assert.match(log, /"status":"completed"/, "the release records why the target was released");
    assert.match(log, /"action":"released"/, "local mode has no container action");
  } finally {
    await runtime?.stop();
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AgentRuntime.logCrash records process_crash in every Project main.log", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-runtime-crash-"));
  const home = join(root, "home");
  mkdirSync(root, { recursive: true });
  // persistProjectId rewrites task.json, so the config file must exist first.
  writeFileSync(join(root, "task.json"), `${JSON.stringify({
    board: { name: "test", skills: [], projects: [{ source: "start", goal: "done" }] },
    workers: [
      { type: "claude-code", taskTypes: ["plan", "supervise"], maxRunning: 1, priority: 1 },
      { type: "claude-code", taskTypes: ["execute"], maxRunning: 1, priority: 1 },
    ],
    scheduler: { maxRunningProjects: 1, intervalMs: 3_000 },
    phase: { supervise: { intervalMs: 60_000 } },
  }, null, 2)}\n`);
  const registry = new ProjectStoreRegistry(join(home, "projects"));
  const server = new GraphHttpServer(registry);
  await server.start();
  const project = await new GraphClient(server.baseUrl).createProject({ title: "start", target: "start", goal: "done" });
  const config = configuration(root);
  config.board.projects[0]!.id = project.id;
  const runtime = new AgentRuntime(config, {
    graphUrl: server.baseUrl, projectsRoot: join(home, "projects"), peakHome: home, installSkills: false,
  });
  try {
    const projects = await runtime.start();
    assert.ok(projects.length >= 1, "at least one Project registered");
    runtime.logCrash("uncaughtException", new Error("boom crash"));
    for (const project of projects) {
      const log = readFileSync(join(home, "projects", project.id, "logs", "main.log"), "utf8");
      assert.match(log, /"type":"process_crash"/);
      assert.match(log, /"kind":"uncaughtException"/);
      assert.match(log, /boom crash/);
    }
  } finally {
    await runtime.stop();
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Joint Plan discovers leaf Paths from both active and completed Projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-runtime-federation-status-"));
  const projectsRoot = join(root, "projects");
  const registry = new ProjectStoreRegistry(projectsRoot);
  let mounted: string[] = [];
  const server = new GraphHttpServer(
    registry,
    undefined,
    [],
    (taskName) => taskName === "status-joint" ? mounted : undefined,
  );
  await server.start();
  const graph = new GraphClient(server.baseUrl, { projectsRoot });
  let runtime: AgentRuntime | undefined;
  try {
    const active = await graph.createProject({ title: "active", target: "active source", goal: "active goal" });
    const completed = await graph.createProject({ title: "completed", target: "completed source", goal: "completed goal" });
    mounted = [active.id, completed.id];

    const activeIntent = await graph.createIntent(active.id, {
      from: [{ projectId: active.id, id: "origin", description: "active source" }],
      description: "produce active evidence", createdBy: "test",
    });
    const activeResult = await graph.conclude(active.id, activeIntent.id, {
      description: "active evidence", artifact: null, concludedBy: "test",
    });
    await graph.putPathAbstract(active.id, activeResult.fact.id, {
      factRef: { projectId: active.id, id: activeResult.fact.id, description: activeResult.fact.description },
      pathOverview: "active path", verifiedCore: ["active evidence"],
    });

    const completedIntent = await graph.createIntent(completed.id, {
      from: [{ projectId: completed.id, id: "origin", description: "completed source" }],
      description: "produce completed evidence", createdBy: "test",
    });
    const completedResult = await graph.conclude(completed.id, completedIntent.id, {
      description: "completed evidence", artifact: null, concludedBy: "test",
    });
    await graph.putPathAbstract(completed.id, completedResult.fact.id, {
      factRef: { projectId: completed.id, id: completedResult.fact.id, description: completedResult.fact.description },
      pathOverview: "completed path", verifiedCore: ["completed evidence"],
    });
    await graph.complete(completed.id, {
      from: [{ projectId: completed.id, id: completedResult.fact.id, description: completedResult.fact.description }],
      description: "completed goal proven", completedBy: "test",
    });

    const config: ResolvedTaskConfig = {
      configPath: join(root, "task.json"), taskDir: root,
      board: {
        name: "status-joint", skills: [],
        projects: [
          { id: active.id, source: "active source", goal: "active goal" },
          { id: completed.id, source: "completed source", goal: "completed goal" },
        ],
      },
      workers: {},
      scheduler: { maxRunningProjects: 2, intervalMs: 60_000 },
      phase: { plan: {}, supervise: { intervalMs: 60_000 }, execute: { maxArtifactBytes: 1024, customProfile: [] } },
    };
    runtime = new AgentRuntime(config, { graphUrl: server.baseUrl, projectsRoot, installSkills: false });
    await runtime.start();

    const context = { taskName: "status-joint" };
    assert.deepEqual(
      (await graph.jointPlanPaths(context, completed.id)).map((ref) => ref.projectId),
      [active.id],
      "the completed target discovers the active Project Path",
    );
    assert.deepEqual(
      (await graph.jointPlanPaths(context, active.id)).map((ref) => ref.projectId),
      [completed.id],
      "the active target discovers the completed Project Path",
    );
  } finally {
    await runtime?.stop();
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
