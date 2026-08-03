import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTaskConfig } from "../dist/config/task-config.js";
import { initializeTaskSkills } from "../dist/config/task-skill-installer.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { GraphClient } from "../dist/graph/graph-client.js";
import { GraphHttpServer } from "../dist/graph/http-server.js";
import { ProjectStoreRegistry } from "../dist/graph/project-store-registry.js";
import { leafFacts } from "../dist/graph/types.js";
import { TaskExecutor, type TaskWorkers } from "../dist/runtime/task-executor.js";
import type { TaskType } from "../dist/config/types.js";
import type { SessionRef, WorkerResult } from "../dist/worker/types.js";

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

    const scopingDescription = "Use for defining the bounded deliverable contract and evidence rules for this Project.";
    const researchDescription = "Use for collecting and assessing one current primary research or standards source.";
    const incidentDescription = "Use for analyzing one concrete AI or Agent safety incident.";
    const briefContent = "# AI safety intelligence brief\nFive atomic findings and three cross-cutting trends.\n";
    const scoping = "The brief contract fixes five finding slots (two research/standards, one incident, one policy, one engineering practice), each requiring a primary URL, date, finding, uncertainty, and implication.";
    const findings = [
      "NIST AI RMF profile defines one current governance requirement with stated uncertainty and operational impact.",
      "A current primary paper reports one sandboxing finding with stated limitations and practical implication.",
      "One documented Agent tool-confusion incident establishes a concrete privilege-escalation risk and mitigation.",
      "One current policy source establishes a deployment disclosure requirement and its engineering impact.",
      "One current engineering-practice source establishes a measurable tool-authorization control and its limitation.",
    ];
    const findingRef = (factId: string, description: string): { projectId: string; factId: string; description: string } =>
      ({ projectId: project.id, factId, description });
    const worker = new ScriptedWorker([
      // 范围：只有第一个 Intent 从 origin 出发。
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [findingRef("origin", origin)], customProfile: scopingDescription, description: "Fix the bounded brief contract: five finding slots and evidence rules" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: scoping, artifact: null }) },
      // 深挖：五项发现全部从范围叶 f001 出发，绝不从 origin。
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: [findingRef("f001", scoping)], customProfile: researchDescription, description: "Assess the current NIST AI RMF profile as one standards source" },
        { from: [findingRef("f001", scoping)], customProfile: researchDescription, description: "Assess one current primary paper about Agent sandboxing" },
        { from: [findingRef("f001", scoping)], customProfile: incidentDescription, description: "Analyze one documented Agent tool-confusion incident" },
        { from: [findingRef("f001", scoping)], description: "Assess one current AI deployment policy source" },
        { from: [findingRef("f001", scoping)], description: "Assess one current tool-authorization engineering-practice source" },
      ] }) },
      ...findings.map((description): Scripted => ({
        type: "execute", text: JSON.stringify({ kind: "fact", description, artifact: null }),
      })),
      { type: "supervise", text: JSON.stringify({ kind: "noop" }) },
      // 汇总：只合并已建立的叶，不采集新证据。
      { type: "plan", text: JSON.stringify({ kind: "intents", intents: [
        { from: findings.map((description, index) => findingRef(`f00${index + 2}`, description)), description: "Synthesize the five existing findings into one bounded intelligence brief without collecting new evidence" },
      ] }) },
      { type: "execute", text: JSON.stringify({ kind: "fact", description: "The final brief combines exactly five independently established findings and three cross-cutting trends; detailed evidence is in its Artifact.", artifact: { filename: "final-brief.md", mediaType: "text/markdown", content: briefContent } }) },
      { type: "plan", text: JSON.stringify({ kind: "complete", from: [findingRef("f007", "The final brief combines exactly five independently established findings and three cross-cutting trends; detailed evidence is in its Artifact.")], description: "The required AI safety intelligence brief and its three trends are complete." }) },
    ]);

    const executor = new TaskExecutor(
      config,
      { key: "project-1", origin, ...configured },
      graph,
      worker,
      federation,
      projectDir,
    );

    // 范围：一个从 origin 出发的 scoping Intent。
    await executor.plan(project.id, "p1");
    let intents = (await graph.getProject(project.id)).intents;
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0]!.from.map((ref) => ref.factId), ["origin"]);
    assert.equal(intents[0]!.customProfile, scopingDescription);
    await executor.execute(project.id, intents[0]!, "e1");
    assert.deepEqual(leafFacts(await graph.getProject(project.id)).map((fact) => fact.id), ["f001"]);

    // 深挖：五项发现全部从范围叶 f001 出发。
    await executor.plan(project.id, "p2");
    intents = (await graph.getProject(project.id)).intents;
    const findingsIntents = intents.filter((intent) => intent.to === null);
    assert.equal(findingsIntents.length, 5);
    for (const intent of findingsIntents) assert.deepEqual(intent.from.map((ref) => ref.factId), ["f001"]);
    for (let index = 0; index < 5; index += 1) await executor.execute(project.id, findingsIntents[index]!, `e${index + 2}`);
    assert.deepEqual(leafFacts(await graph.getProject(project.id)).map((fact) => fact.id), ["f002", "f003", "f004", "f005", "f006"]);

    // 汇总：只合并已建立的叶。
    await executor.supervise(project.id, "s1");
    await executor.plan(project.id, "p3");
    intents = (await graph.getProject(project.id)).intents;
    const synthesis = intents.find((intent) => intent.to === null)!;
    assert.ok(synthesis, "synthesis intent should be open");
    assert.equal(synthesis.from.length, 5);
    assert.deepEqual(synthesis.from.map((ref) => ref.factId), ["f002", "f003", "f004", "f005", "f006"]);
    await executor.execute(project.id, synthesis, "e7");
    await executor.plan(project.id, "p4");

    const result = await graph.getProject(project.id);
    assert.equal(result.project.status, "completed");
    assert.equal(readFileSync(join(root, "final-brief.md"), "utf8"), briefContent, "final deliverable materialized next to task.json");
    assert.deepEqual(leafFacts(result).map((fact) => fact.id), ["f007"]);
    const factIds = result.facts.map((fact) => fact.id);
    assert.deepEqual(factIds.sort(), ["f001", "f002", "f003", "f004", "f005", "f006", "f007", "goal", "origin"]);
    assert.ok(result.facts.filter((fact) => /^f00[2-6]$/.test(fact.id)).every((fact) => fact.artifact === null));
    assert.equal(result.facts.find((fact) => fact.id === "f007")?.artifact?.mediaType, "text/markdown");
    assert.equal("customProfile" in result.facts.find((fact) => fact.id === "f001")!, false);
    assert.equal(result.intents[0]?.customProfile, scopingDescription);
    assert.equal(result.intents[1]?.customProfile, researchDescription);
    assert.equal(result.intents[3]?.customProfile, incidentDescription);
    assert.match(result.intents[0]!.customProfileDigest!, /^[0-9a-f]{16}$/);
    assert.equal(result.hints.length, 0);
    const completion = result.intents.find((intent) => intent.to?.factId === "goal");
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
