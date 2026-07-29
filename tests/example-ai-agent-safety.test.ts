import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTaskConfig } from "../dist/config/task-config.js";
import { initializeTaskSkills } from "../dist/config/task-skill-installer.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GraphClient } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { TaskExecutor, type TaskWorkers } from "../dist/runtime/task-executor.js";
import type { TaskType } from "../dist/config/types.js";
import type { SessionRef, WorkerResult } from "../dist/worker/types.js";

interface Scripted { type: TaskType; text: string }

class ScriptedWorker implements TaskWorkers {
  private readonly script: Scripted[];
  constructor(outputs: Scripted[]) { this.script = [...outputs]; }
  pick(): string { return "opencode"; }
  async execute(_worker: string, type: TaskType): Promise<WorkerResult> {
    const next = this.script.shift();
    assert.ok(next, "worker script exhausted");
    assert.equal(next.type, type, `expected ${next.type} call, got ${type}`);
    return { text: next.text, stdout: "", stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true };
  }
}

test("ai_agent_safety example: full lifecycle through HTTP + TaskExecutor", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-aihot-"));
  const workspace = join(root, "workspace");
  const projects = join(root, "projects");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projects, { recursive: true });
  const config = structuredClone(loadTaskConfig("examples/ai_agent_safety"));
  config.board.workspace = workspace;
  initializeTaskSkills(config, { agentsDir: join(root, "agents-skills"), claudeDir: join(root, "claude-skills") });

  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const configured = config.board.projects[0]!;
    const origin = `Project "${configured.name}" is open and has not yet proven its goal.`;
    const project = await graph.createProject({
      title: configured.name,
      target: origin,
      goal: configured.goal,
    });
    const projectDir = join(projects, project.id);
    const federation = new FederationBus();
    federation.register(project.id, projectDir, project.scope);

    writeFileSync(join(workspace, "safety-sweep.md"), "# AI safety leads\n- New Agent sandboxing study\n");
    writeFileSync(join(workspace, "verified-paper.md"), "# Agent sandboxing study\nPrimary paper and repository evidence.\n");
    const worker = new ScriptedWorker([
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [{ projectId: project.id, factId: "origin", description: origin }], description: "Collect recent AI safety research and standards" },
        { from: [{ projectId: project.id, factId: "origin", description: origin }], description: "Collect recent AI Agent incidents and mitigations" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "Safety research sweep found one relevant Agent sandboxing study; evidence is in the Artifact.", artifact: { localPath: "safety-sweep.md", mediaType: "text/markdown" } }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "Incident sweep identified tool-confusion and privilege-escalation patterns requiring guardrails." }) },
      { type: "supervise", text: JSON.stringify({ kind: "hint", content: "Verify the sandboxing study against its primary paper and repository." }) },
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [{ projectId: project.id, factId: "f001", description: "Safety research sweep found one relevant Agent sandboxing study; evidence is in the Artifact." }], description: "Verify the Agent sandboxing study" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "Verified Agent sandboxing study with primary paper and repository; findings and limitations are summarized in the Artifact.", artifact: { localPath: "verified-paper.md", mediaType: "text/markdown" } }) },
      { type: "plan", text: JSON.stringify({ kind: "complete", from: [{ projectId: project.id, factId: "f003", description: "Verified Agent sandboxing study with primary paper and repository; findings and limitations are summarized in the Artifact." }], description: "Current AI safety summary: Agent sandboxing evidence is credible and tool privilege escalation remains a key implementation risk." }) },
    ]);

    const executor = new TaskExecutor(
      config,
      { key: "project-1", origin, ...configured },
      graph,
      worker,
      federation,
      projectDir,
    );

    await executor.plan(project.id, "p1");
    let intents = (await graph.getProject(project.id)).intents;
    assert.equal(intents.length, 2);
    await executor.execute(project.id, intents[0]!, "e1");
    await executor.execute(project.id, intents[1]!, "e2");
    await executor.supervise(project.id, "s1");
    await executor.plan(project.id, "p2");
    intents = (await graph.getProject(project.id)).intents;
    const verify = intents.find((i) => i.to === null)!;
    assert.ok(verify, "verify intent should be open");
    await executor.execute(project.id, verify, "e3");
    await executor.plan(project.id, "p3");

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    const factIds = result.facts.map((f) => f.id);
    assert.deepEqual(factIds.sort(), ["f001", "f002", "f003", "goal", "origin"]);
    assert.equal(result.facts.find((f) => f.id === "f001")?.artifact?.mediaType, "text/markdown");
    assert.equal(result.hints.length, 1);
    assert.match(result.hints[0]!.content, /sandboxing/i);
    const completion = result.intents.find((i) => i.to?.factId === "goal");
    assert.ok(completion && completion.concludedBy, "completion intent must exist and be concluded");

    const log = readFileSync(join(projectDir, "logs", "main.log"), "utf8");
    for (const event of ["intent_created", "intent_concluded", "hint_added", "project_completed", "artifact_uploaded"]) {
      assert.match(log, new RegExp(event), `main.log missing ${event}`);
    }
    const logs = readdirSync(join(projectDir, "logs"));
    assert.ok(logs.some((n) => /^graph-.*-plan\.json$/.test(n)));
    assert.ok(logs.some((n) => /^graph-.*-supervise\.json$/.test(n)));
    assert.ok(logs.some((n) => /^graph-.*-execute\.json$/.test(n)));
    const executeJson = logs.find((n) => /^graph-.*-execute\.json$/.test(n))!;
    assert.match(readFileSync(join(projectDir, "logs", executeJson), "utf8"), /ai-agent-safety/);
    assert.equal(logs.some((n) => n.includes("output")), false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
