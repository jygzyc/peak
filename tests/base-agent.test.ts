import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { MainAgent } from "../dist/agent/main-agent.js";
import { EvaluatorAgent, ExplorerAgent, MetacogAgent } from "../dist/agent/role-agents.js";
import { explorerExtra, evaluatorExtra, metacogExtra } from "../dist/agent/prompt-builder.js";
import { ServerSessionGraphReader } from "../dist/server/session-graph-reader.js";
import { agentRecords, createProject, env, freshSetup } from "./helper.ts";

test("BaseAgent: planner writes role-safe JSON records outside Graph", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  worker.register(/automated planning module/i, env("decisions", {
    createIntents: [{ description: "scan", from: [], priority: 2, dispatchExplorer: true }],
    failIntents: [], consumeHints: [], concludeRun: null,
  }));
  const agent = new MainAgent({
    project, config, workerPool: worker, graphReader: new ServerSessionGraphReader(graph),
  });

  const result = await agent.run({});
  const records = await agentRecords(project);

  assert.equal(result.decision.createIntents[0]?.description, "scan");
  assert.match(
    worker.calls()[0]!.prompt,
    /# Planner Role[\s\S]*Contract: main_decision[\s\S]*"kind": "decisions"/,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "validated");
  assert.match(records[0]!.promptHash!, /^[a-f0-9]{64}$/);
  assert.equal(records[0]!.contextArtifact?.relativePath, `agents/${result.agentId}/context.json`);
  assert.equal(records[0]!.outputArtifact?.relativePath, `agents/${result.agentId}/output.json`);
  assert.ok(existsSync(records[0]!.contextArtifact!.resolvedPath));
  assert.match(JSON.parse(readFileSync(records[0]!.contextArtifact!.resolvedPath, "utf8")).content, /## Objective/);
  assert.equal("subagentRuns" in graph, false);
});

test("BaseAgent: worker cwd is the configured workspace", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph, { workspaceDir: "configured-workspace" });
  worker.register(/automated planning module/i, env("decisions", {
    createIntents: [], failIntents: [], consumeHints: [], concludeRun: null,
  }));
  await new MainAgent({
    project, config, workerPool: worker, graphReader: new ServerSessionGraphReader(graph),
  }).run({});
  assert.equal(worker.calls()[0]!.cwd, "configured-workspace");
});

test("ExplorerAgent: rejects output outside the candidate_fact contract", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  const intent = graph.addIntent(project.id, { description: "find Y", creator: "planner" });
  worker.register(/Explorer Role/i, "unstructured result");
  const agent = new ExplorerAgent({
    profile: config.profiles.explorer,
    profileId: "explorer",
    project,
    workerPool: worker,
    config,
    graphReader: new ServerSessionGraphReader(graph),
  });

  await assert.rejects(
    agent.run({
      intent,
      promptExtra: explorerExtra(intent.id, intent.description, [], []),
    }),
    /no JSON object/,
  );
  assert.equal(worker.calls().length, 1);
  assert.equal((await agentRecords(project))[0]!.status, "failed");
});

test("EvaluatorAgent: enforces the verdict contract", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  const candidate = graph.addFact(project.id, { description: "candidate", source: "explorer" });
  worker.register(/Evaluator Role/i, env("decisions", {
    createIntents: [], failIntents: [], consumeHints: [], concludeRun: null,
  }));
  const agent = new EvaluatorAgent({
    profile: config.profiles.evaluator,
    profileId: "evaluator",
    project,
    workerPool: worker,
    config,
    graphReader: new ServerSessionGraphReader(graph),
  });
  await assert.rejects(
    agent.run({ candidate, promptExtra: evaluatorExtra(candidate) }),
    /contract="verdict".*kind="decisions"/,
  );
  assert.equal((await agentRecords(project))[0]!.status, "failed");
});

test("MetacogAgent: accepts hints and stop only", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  worker.register(/Metacog Role/i, env("hints", { hints: [{ content: "inspect auth" }] }));
  const agent = new MetacogAgent({
    profile: config.profiles.metacog,
    profileId: "metacog",
    project,
    workerPool: worker,
    config,
    graphReader: new ServerSessionGraphReader(graph),
  });
  const result = await agent.run({ promptExtra: metacogExtra("scheduled") });
  assert.equal(result.output.kind, "hints");
});

test("BaseAgent: rejects API workers that cannot read local JSON", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  config.workers.direct = { kind: "api" };
  config.profiles.explorer.runtime.worker = "direct";
  const agent = new ExplorerAgent({
    profile: config.profiles.explorer,
    profileId: "explorer",
    project,
    workerPool: worker,
    config,
    graphReader: new ServerSessionGraphReader(graph),
  });
  await assert.rejects(agent.run({ promptExtra: "test" }), /cannot read session JSON artifacts/);
  assert.equal((await agentRecords(project)).length, 0);
});
