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

test("ai_hot_analysis example: full lifecycle through HTTP + TaskExecutor", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-aihot-"));
  const workspace = join(root, "workspace");
  const projects = join(root, "projects");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projects, { recursive: true });
  const config = structuredClone(loadTaskConfig("examples/ai_hot_analysis/task.json"));
  config.task.workspace = workspace;
  initializeTaskSkills(config, { agentsDir: join(root, "agents-skills"), claudeDir: join(root, "claude-skills") });

  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl);
  try {
    const project = await graph.createProject({
      title: config.task.name!,
      target: config.task.target,
      goal: config.task.goal,
    });
    const projectDir = join(projects, project.id);
    const federation = new FederationBus();
    federation.register(project.id, projectDir, project.scope);

    writeFileSync(join(workspace, "product.md"), "# Product leads\n- Acme launched X\n");
    writeFileSync(join(workspace, "event-acme-x.md"), "# Acme X\nScore 9. Evidence: ...\n");
    const worker = new ScriptedWorker([
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [{ projectId: project.id, factId: "origin" }], description: "Sweep product/company AI news for today" },
        { from: [{ projectId: project.id, factId: "origin" }], description: "Sweep research/open-source AI news for today" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "Product sweep: date/cutoff stated; 1 lead Acme/acme-x launch; report in artifact.", artifact: { localPath: "product.md", mediaType: "text/markdown" } }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "Research sweep: date/cutoff stated; no qualifying papers today." }) },
      { type: "supervise", text: JSON.stringify({ kind: "hint", content: "No policy/regulation sweep yet; consider coverage there." }) },
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [{ projectId: project.id, factId: "f001" }], description: "Verify the Acme X launch event" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "Verified Acme X launch: score 9, primary source confirmed, Asia/Shanghai date eligible. Detail in artifact.", artifact: { localPath: "event-acme-x.md", mediaType: "text/markdown" } }) },
      { type: "plan", text: JSON.stringify({ kind: "complete", from: [{ projectId: project.id, factId: "f003" }], description: "Digest: today 1 hotspot (Acme X, score 9). Research quiet. Excluded: none unresolved." }) },
    ]);

    const executor = new TaskExecutor(config, graph, worker, federation, projectDir);

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
    assert.match(result.hints[0]!.content, /policy/i);
    const completion = result.intents.find((i) => i.to?.factId === "goal");
    assert.ok(completion && completion.concludedBy, "completion intent must exist and be concluded");

    const log = readFileSync(join(projectDir, "logs", "main.log"), "utf8");
    for (const event of ["intent_created", "intent_concluded", "hint_added", "project_completed", "artifact_uploaded"]) {
      assert.match(log, new RegExp(event), `main.log missing ${event}`);
    }
    const logs = readdirSync(join(projectDir, "logs"));
    assert.ok(logs.some((n) => /^graph-.*-plan\.yaml$/.test(n)));
    assert.ok(logs.some((n) => /^graph-.*-supervise\.yaml$/.test(n)));
    assert.ok(logs.some((n) => /^graph-.*-execute\.yaml$/.test(n)));
    const executeYaml = logs.find((n) => /^graph-.*-execute\.yaml$/.test(n))!;
    assert.match(readFileSync(join(projectDir, "logs", executeYaml), "utf8"), /daily-ai-hotspots/);
    assert.equal(logs.some((n) => n.includes("output")), false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
