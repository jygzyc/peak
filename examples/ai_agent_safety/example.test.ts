import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTaskConfig } from "../../dist/utils/task-config.js";
import { initializeTaskSkills } from "../../dist/utils/task-skill-installer.js";
import { FederationBus } from "../../dist/graph/federation-bus.js";
import { GraphClient } from "../../dist/graph/graph-client.js";
import { GraphHttpServer } from "../../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../../dist/graph/project-store-registry.js";
import { leafFacts } from "../../dist/graph/types.js";
import { TaskExecutor, type TaskWorkers } from "../../dist/runtime/task-executor.js";
import type { TaskType } from "../../dist/worker/types.js";
import type { SessionRef, WorkerResult } from "../../dist/worker/types.js";

interface Scripted { type: TaskType; text: string }

class ScriptedWorker implements TaskWorkers {
  private readonly script: Scripted[];
  constructor(outputs: Scripted[]) { this.script = [...outputs]; }
  pick(): string { return "opencode"; }
  release(): void {}
  async execute(_worker: string, type: TaskType): Promise<WorkerResult> {
    const next = this.script.shift();
    assert.ok(next, "worker script exhausted");
    assert.equal(next.type, type, `expected ${next.type} call, got ${type}`);
    return { text: next.text, stdout: "", stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true };
  }
}

test("ai_agent_safety example: depth-first DAG lifecycle through HTTP + TaskExecutor", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-aihot-"));
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const config = structuredClone(loadTaskConfig("examples/ai_agent_safety"));
  config.taskDir = root;
  cpSync("examples/ai_agent_safety/skills", join(root, "skills"), { recursive: true });
  initializeTaskSkills(config, { agentsDir: join(root, "agents-skills"), claudeDir: join(root, "claude-skills") });

  const registry = new ProjectStoreRegistry(projects);
  const server = new GraphHttpServer(registry);
  await server.start();
  const graph = new GraphClient(server.baseUrl, { projectsRoot: projects });
  try {
    const configured = config.board.projects[0]!;
    const origin = configured.source;
    const project = await graph.createProject({
      title: configured.source,
      target: origin,
      goal: configured.goal,
    });
    const projectDir = join(projects, project.id);
    const federation = new FederationBus();
    federation.register(project.id, projectDir, project.scope);

    const researchDescription = "Use when assessing one AI safety research paper, official standard, or regulator publication.";
    const incidentDescription = "Use when investigating one documented AI or Agent safety incident.";
    const briefContent = "# AI safety intelligence brief\nFive atomic findings and three cross-cutting trends.\n";
    const scoping = "The brief contract fixes five finding slots (two research/standards, one incident, one policy, one engineering practice), each requiring a primary URL, date, finding, uncertainty, and implication.";
    const findings = [
      "NIST AI RMF profile defines one current governance requirement with stated uncertainty and operational impact.",
      "A current primary paper reports one sandboxing finding with stated limitations and practical implication.",
      "One documented Agent tool-confusion incident establishes a concrete privilege-escalation risk and mitigation.",
      "One current policy source establishes a deployment disclosure requirement and its engineering impact.",
      "One current engineering-practice source establishes a measurable tool-authorization control and its limitation.",
    ];
    const findingRef = (id: string, description: string): { projectId: string; id: string; description: string } =>
      ({ projectId: project.id, id, description });
    const worker = new ScriptedWorker([
      // 范围：只有第一个 Intent 从 origin 出发。
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [findingRef("origin", origin)], description: "Define the decision audience, evidence window, and acceptance rules for the intelligence brief" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: scoping, artifact: null }) },
      { type: "plan", text: JSON.stringify({ pathOverview: "origin to scoped brief contract", verifiedCore: [scoping] }) },
      // 深挖：executeCapacity = sum(execute Worker maxRunning) = 2，五项发现分三轮、每轮 ≤ 2 个 Intent 从范围叶 f0001 创建。
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [findingRef("f0001", scoping)], customProfile: researchDescription, description: "Assess the current NIST AI RMF profile as one standards source" },
        { from: [findingRef("f0001", scoping)], customProfile: researchDescription, description: "Assess one current primary paper about Agent sandboxing" },
      ] }) },
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [findingRef("f0001", scoping)], customProfile: incidentDescription, description: "Analyze one documented Agent tool-confusion incident" },
        { from: [findingRef("f0001", scoping)], description: "Assess one current AI deployment policy source" },
      ] }) },
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [findingRef("f0001", scoping)], description: "Assess one current tool-authorization engineering-practice source" },
      ] }) },
      ...findings.map((description): Scripted => ({
        type: "execute", text: JSON.stringify({ kind: "fact", description, artifact: null }),
      })),
      { type: "supervise", text: JSON.stringify({ kind: "noop" }) },
      ...findings.map((description, index): Scripted => ({
        type: "plan",
        text: JSON.stringify({ pathOverview: `scoped contract to finding ${index + 1}`, verifiedCore: [description] }),
      })),
      // 汇总：只合并已建立的叶，不采集新证据。
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: findings.map((description, index) => findingRef(`f${String(index + 2).padStart(4, "0")}`, description)), description: "Synthesize the five existing findings into one bounded intelligence brief without collecting new evidence" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "The final brief combines exactly five independently established findings and three cross-cutting trends; detailed evidence is in its Artifact.", artifact: { filename: "final-brief.md", mediaType: "text/markdown", content: briefContent } }) },
      { type: "plan", text: JSON.stringify({ pathOverview: "five verified findings to final brief", verifiedCore: findings }) },
      { type: "plan", text: JSON.stringify({ kind: "complete", from: [findingRef("f0007", "The final brief combines exactly five independently established findings and three cross-cutting trends; detailed evidence is in its Artifact.")], description: "The required AI safety intelligence brief and its three trends are complete." }) },
    ]);

    const executor = new TaskExecutor(
      config,
      { key: "project-1", ...configured },
      graph,
      worker,
      federation,
      projectDir,
    );

    // 范围：一个从 origin 出发的 scoping Intent。
    await executor.plan(project.id, "p1");
    let intents = (await graph.getProject(project.id)).intents;
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0]!.from.map((ref) => ref.id), ["origin"]);
    assert.equal(intents[0]!.customProfile, null);
    await executor.execute(project.id, intents[0]!, "e1");
    assert.deepEqual(leafFacts(await graph.getProject(project.id)).map((fact) => fact.id), ["f0001"]);

    // 深挖：五项发现分三轮、全部从范围叶 f0001 出发（executeCapacity = 2，每轮 ≤ 2 个 Intent）。
    await executor.plan(project.id, "p2");
    await executor.plan(project.id, "p3");
    await executor.plan(project.id, "p4");
    intents = (await graph.getProject(project.id)).intents;
    const findingsIntents = intents.filter((intent) => intent.to === null);
    assert.equal(findingsIntents.length, 5);
    for (const intent of findingsIntents) assert.deepEqual(intent.from.map((ref) => ref.id), ["f0001"]);
    for (let index = 0; index < 5; index += 1) await executor.execute(project.id, findingsIntents[index]!, `e${index + 2}`);
    assert.deepEqual(leafFacts(await graph.getProject(project.id)).map((fact) => fact.id), ["f0002", "f0003", "f0004", "f0005", "f0006"]);

    // 汇总：只合并已建立的叶。
    await executor.supervise(project.id, "s1");
    await executor.plan(project.id, "p5");
    intents = (await graph.getProject(project.id)).intents;
    const synthesis = intents.find((intent) => intent.to === null)!;
    assert.ok(synthesis, "synthesis intent should be open");
    assert.equal(synthesis.from.length, 5);
    assert.deepEqual(synthesis.from.map((ref) => ref.id), ["f0002", "f0003", "f0004", "f0005", "f0006"]);
    await executor.execute(project.id, synthesis, "e7");
    await executor.plan(project.id, "p6");

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    assert.equal(readFileSync(join(projectDir, "out", "final-brief.md"), "utf8"), briefContent, "final deliverable materialized under the Project out directory");
    assert.deepEqual(leafFacts(result).map((fact) => fact.id), ["f0007"]);
    const factIds = result.facts.map((fact) => fact.id);
    assert.deepEqual(factIds.sort(), ["f0001", "f0002", "f0003", "f0004", "f0005", "f0006", "f0007", "goal", "origin"]);
    assert.ok(result.facts.filter((fact) => /^f000[2-6]$/.test(fact.id)).every((fact) => fact.artifact === null));
    assert.equal(result.facts.find((fact) => fact.id === "f0007")?.artifact?.mediaType, "text/markdown");
    assert.equal("customProfile" in result.facts.find((fact) => fact.id === "f0001")!, false);
    assert.equal(result.intents[0]?.customProfile, null);
    assert.equal(result.intents[1]?.customProfile, researchDescription);
    assert.equal(result.intents[3]?.customProfile, incidentDescription);
    assert.equal(result.intents[0]?.customProfileDigest, null);
    assert.match(result.intents[1]!.customProfileDigest!, /^[0-9a-f]{16}$/);
    assert.equal(result.hints.length, 0);
    const completion = result.intents.find((intent) => intent.to?.id === "goal");
    assert.ok(completion && completion.concludedBy, "completion intent must exist and be concluded");

    const log = readFileSync(join(projectDir, "logs", "main.log"), "utf8");
    for (const event of ["intent_created", "intent_concluded", "project_completed", "artifact_uploaded"]) {
      assert.match(log, new RegExp(event), `main.log missing ${event}`);
    }
    const logs = readdirSync(join(projectDir, "logs"));
    assert.ok(logs.some((name) => /^graph-.*-plan\.json$/.test(name)));
    assert.ok(logs.some((name) => /^graph-.*-supervise\.json$/.test(name)));
    const executeJsons = logs.filter((name) => /^graph-.*-execute\.json$/.test(name));
    assert.ok(executeJsons.length >= 7, "one execute snapshot per execution");
    const executeSnapshots = executeJsons.map((name) => readFileSync(join(projectDir, "logs", name), "utf8"));
    assert.ok(executeSnapshots.some((snapshot) => snapshot.includes(researchDescription)), "research profile in an execute snapshot");
    assert.ok(executeSnapshots.some((snapshot) => /"artifact":null/.test(snapshot)), "null-Artifact sources in an execute snapshot");
    assert.ok(executeSnapshots.every((snapshot) => !/"skills"|"workers"/.test(snapshot)), "snapshot never leaks skills/workers");
    assert.equal(logs.some((name) => name.includes("output")), false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
