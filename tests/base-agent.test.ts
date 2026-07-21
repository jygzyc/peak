import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { MainAgent } from "../dist/agent/main-agent.js";
import { EvaluatorAgent, ExplorerAgent, MetacogAgent } from "../dist/agent/role-agents.js";
import { explorerExtra, evaluatorExtra, metacogExtra } from "../dist/agent/prompt-builder.js";
import { ServerSessionGraphReader } from "../dist/server/session-graph-reader.js";
import { roleLogs, createProject, env, freshSetup } from "./helper.ts";

test("BaseAgent: planner writes timestamped context and output JSON under logs", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  config.profiles.planner!.tools = ["read", "grep"];
  worker.register(/automated planning module/i, env("decisions", {
    createIntents: [{ description: "scan", from: [], priority: 2, dispatchExplorer: true }],
    failIntents: [], consumeHints: [], concludeRun: null,
  }));
  const agent = new MainAgent({
    project, config, workerPool: worker, graphReader: new ServerSessionGraphReader(graph),
  });

  const result = await agent.run({});
  const records = await roleLogs(project);

  assert.equal(result.decision.createIntents[0]?.description, "scan");
  assert.match(
    worker.calls()[0]!.prompt,
    /# Planner Role[\s\S]*Contract: main_decision[\s\S]*"kind": "decisions"/,
  );
  assert.match(worker.calls()[0]!.prompt, /Configured tools for this role: read, grep/);
  assert.doesNotMatch(worker.calls()[0]!.prompt, /\/api\/sessions|graph\/snapshot|https?:\/\//);
  assert.equal(records.length, 2);
  const context = records.find((entry) => entry.kind === "context")!;
  const output = records.find((entry) => entry.kind === "output")!;
  assert.ok(existsSync(context.path));
  assert.match((context.data as { content: string }).content, /## Objective/);
  assert.equal((output.data as { kind: string }).kind, "decisions");
  assert.match(context.path, /\d{8}T\d{9}Z-planner-context\.json$/);
  assert.match(output.path, /\d{8}T\d{9}Z-planner-output\.json$/);
  assert.equal(context.path.replace("-context.json", ""), output.path.replace("-output.json", ""));
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
  const logs = await roleLogs(project);
  assert.deepEqual(logs.map((entry) => entry.kind), ["context", "output"]);
  assert.match((logs[1]!.data as { error: string }).error, /no JSON object/);
  assert.equal((logs[1]!.data as { rawText: string }).rawText, "unstructured result");
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
  const logs = await roleLogs(project);
  assert.deepEqual(logs.map((entry) => entry.kind), ["context", "output"]);
  assert.match((logs[1]!.data as { error: string }).error, /contract="verdict"/);
});

test("BaseAgent: records a failed Worker result under logs", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  worker.register(/# Explorer Role/i, "partial output", 7);
  const agent = new ExplorerAgent({
    profile: config.profiles.explorer,
    profileId: "explorer",
    project,
    workerPool: worker,
    config,
    graphReader: new ServerSessionGraphReader(graph),
  });

  await assert.rejects(agent.run({ promptExtra: "assignment" }), /explorer worker failed/);
  const logs = await roleLogs(project);
  assert.deepEqual(logs.map((entry) => entry.kind), ["context", "output"]);
  assert.equal((logs[1]!.data as { status: string }).status, "failed");
  assert.equal((logs[1]!.data as { returncode: number }).returncode, 7);
  assert.equal((logs[1]!.data as { rawText: string }).rawText, "partial output");
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

test("BaseAgent: sends the configured Agent input to its selected Worker", async () => {
  const { graph, worker, config } = freshSetup();
  const project = createProject(graph);
  config.workers.direct = { type: "pi", model: "anthropic/sonnet" };
  config.profiles.explorer.runtime.worker = "direct";
  config.profiles.explorer.tools = ["read", "grep"];
  let receivedType: string | undefined;
  let receivedModel: string | undefined;
  worker.register(/# Explorer Role/i, (request) => {
    receivedType = request.config.type;
    receivedModel = request.config.model;
    return env("fact", { description: "worker result", confidence: 0.9 });
  });
  const agent = new ExplorerAgent({
    profile: config.profiles.explorer,
    profileId: "explorer",
    project,
    workerPool: worker,
    config,
    graphReader: new ServerSessionGraphReader(graph),
  });
  const result = await agent.run({ promptExtra: "assignment" });
  assert.equal(result.output.kind, "fact");
  assert.equal(receivedType, "pi");
  assert.equal(receivedModel, "anthropic/sonnet");
  assert.match(worker.calls().at(-1)?.prompt ?? "", /Configured tools for this role: read, grep/);
  assert.equal((await roleLogs(project)).length, 2);
});
