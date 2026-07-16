import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { runSubagent, runSubagentWithText, plannerExtra, explorerExtra, evaluatorExtra, metacogExtra } from "../dist/agent/subagent-runner.js";
import { MainAgent } from "../dist/agent/main-agent.js";
import { ServerSessionGraphReader } from "../dist/server/session-graph-reader.js";
import { freshSetup, createProject, env, minimalConfig } from "./helper.ts";

let runSequence = 0;

function roleContext(graph: ReturnType<typeof freshSetup>["graph"], project: ReturnType<typeof createProject>) {
  return {
    project,
    graphReader: new ServerSessionGraphReader(graph),
    runId: `run_test_${++runSequence}`,
  };
}

function plannerAgent(
  graph: ReturnType<typeof freshSetup>["graph"],
  project: ReturnType<typeof createProject>,
  config: ReturnType<typeof minimalConfig>,
  worker: ReturnType<typeof freshSetup>["worker"],
) {
  const run = graph.createSubagentRun(project.id, {
    profileId: "planner",
    role: "planner",
    workerName: config.profiles.planner.runtime.worker,
  });
  return {
    agent: new MainAgent({
      project,
      config,
      workerPool: worker,
      graphReader: new ServerSessionGraphReader(graph),
    }),
    input: {
      runId: run.id,
      workerName: run.workerName,
      onRunUpdate: (patch: Parameters<typeof graph.updateSubagentRun>[2]) =>
        graph.updateSubagentRun(project.id, run.id, patch),
    },
  };
}

test("planner via MainAgent: empty graph returns createIntents decisions", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/automated planning module/i, env("decisions", {
    createIntents: [{ description: "scan", from: [], priority: 2, dispatchExplorer: true }],
    failIntents: [], consumeHints: [], concludeRun: null,
  }));

  const { agent, input } = plannerAgent(graph, p, config, worker);
  const { decision, runId } = await agent.run(input);
  assert.equal(decision.createIntents.length, 1);
  assert.equal(decision.createIntents[0].description, "scan");
  const run = graph.getSubagentRun(p.id, runId)!;
  assert.equal(run.role, "planner");
  assert.equal(run.status, "pending");
  assert.match(run.promptHash!, /^[a-f0-9]{64}$/);
  assert.equal(run.promptManifest?.components[0]?.kind, "primary");
  assert.equal(run.promptManifest?.components[0]?.source, "builtin:planner");
  assert.equal(run.promptManifest?.components[0]?.resolvedPath, undefined);
  const graphComponent = run.promptManifest?.components.find((component) => component.kind === "graph-context");
  assert.equal(graphComponent?.artifactSha256, run.contextArtifact?.sha256);
  assert.equal(graphComponent?.graphSeq, run.contextArtifact?.graphSeq);
  assert.ok(run.promptManifest?.components.some((component) => component.kind === "assignment"));
  assert.ok(run.promptManifest?.components.some((component) => component.kind === "output-contract"));
  assert.ok(run.contextArtifact);
  assert.ok(run.outputArtifact);
  assert.ok(existsSync(run.contextArtifact!.resolvedPath));
  const artifact = JSON.parse(readFileSync(run.contextArtifact!.resolvedPath, "utf8"));
  assert.match(artifact.content, /## Objective/);
});

test("runSubagent uses workspaceDir rather than the persistent sessionDir as worker cwd", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph, { workspaceDir: "configured-workspace" });
  worker.register(/automated planning module/i, env("decisions", {
    createIntents: [], failIntents: [], consumeHints: [], concludeRun: null,
  }));
  const { agent, input } = plannerAgent(graph, p, config, worker);
  await agent.run(input);
  assert.equal(worker.calls()[0]!.cwd, "configured-workspace");
  assert.notEqual(p.workspaceDir, p.sessionDir);
});

test("planner via MainAgent: hint-received returns failIntents", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const i1 = graph.addIntent(p.id, { description: "wrong dir", creator: "planner" });
  const h1 = graph.addHint(p.id, { content: "stop", creator: "metacog", kind: "stop-explorer", targetIntentId: i1.id });

  worker.register(/## Hints Requiring Response/i, env("decisions", {
    createIntents: [],
    failIntents: [{ intentId: i1.id, reason: "hint says stop" }],
    consumeHints: [h1.id], concludeRun: null,
  }));

  const { agent, input } = plannerAgent(graph, p, config, worker);
  const { decision } = await agent.run({ ...input, hints: [h1] });
  assert.equal(decision.failIntents.length, 1);
  assert.equal(decision.failIntents[0].intentId, i1.id);
  assert.deepEqual(decision.consumeHintIds, [h1.id]);
});

test("planner via MainAgent: consumes only explicitly selected hints", async () => {
  // Planner selectively consumes only h1, ignoring h2 — its choice must be
  // respected (previously MainAgent overwrote consumeHintIds with ALL hints).
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const h1 = graph.addHint(p.id, { content: "act on me", creator: "metacog", kind: "direction" });
  const h2 = graph.addHint(p.id, { content: "ignore me", creator: "metacog", kind: "direction" });

  worker.register(/## Hints Requiring Response/i, env("decisions", {
    createIntents: [],
    failIntents: [],
    consumeHints: [h1.id], // explicitly consume only h1
    concludeRun: null,
  }));

  const { agent, input } = plannerAgent(graph, p, config, worker);
  const { decision } = await agent.run({ ...input, hints: [h1, h2] });
  assert.deepEqual(decision.consumeHintIds, [h1.id]);
});

test("planner via MainAgent: does not consume unselected hints", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const hAction = graph.addHint(p.id, { content: "do X", creator: "metacog", kind: "direction" });
  const hWarn = graph.addHint(p.id, { content: "heads up", creator: "metacog", kind: "warning" });

  worker.register(/## Hints Requiring Response/i, env("decisions", {
    createIntents: [],
    failIntents: [],
    consumeHints: [],
    concludeRun: null,
  }));

  const { agent, input } = plannerAgent(graph, p, config, worker);
  const { decision } = await agent.run({ ...input, hints: [hAction, hWarn] });
  assert.deepEqual(decision.consumeHintIds, []);
});

test("planner via MainAgent: verdict-driven can conclude", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/## Recent Evaluator Verdicts/i, env("decisions", {
    createIntents: [], failIntents: [], consumeHints: [],
    concludeRun: { description: "goal achieved" },
  }));

  const { agent, input } = plannerAgent(graph, p, config, worker);
  const { decision } = await agent.run({
    ...input,
    recentVerdicts: [{ factId: "f001", verdict: { decision: "pass", reason: "ok" } }],
  });
  assert.ok(decision.concludeRun);
  assert.equal(decision.concludeRun!.description, "goal achieved");
});

test("explorer via runSubagent: produces candidate fact", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "find X", creator: "planner" });
  worker.register(/Explorer Role/i, env("fact", { description: "X is 42", evidence: ["measured"], confidence: 0.9 }));

  const output = await runSubagent({
    profile: config.profiles.explorer, profileId: "explorer",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, []),
  });
  assert.equal(output.kind, "fact");
  assert.equal(output.fact.description, "X is 42");
  assert.equal(output.fact.confidence, 0.9);
});

test("explorer via runSubagent: conclude fallback recovers from unparseable first output", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "find Y", creator: "planner" });

  // First call (execute phase, matched by "Explorer Role"): returns prose without
  // a valid JSON envelope → parseEnvelope throws → conclude fallback fires.
  worker.register(/Explorer Role/i, "I looked around but did not find anything useful yet.");
  // Conclude phase (matched by the conclude prompt's "CONCLUDE" marker, registered
  // last so it unshifts to highest priority): returns a valid fact envelope.
  worker.register(/CONCLUDE/i, env("fact", { description: "Y not found, blocked by permissions", evidence: ["access denied"], confidence: 0.2 }));

  const result = await runSubagentWithText({
    profile: config.profiles.explorer, profileId: "explorer",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, []),
  });
  assert.equal(result.output.kind, "fact");
  assert.equal(result.output.fact.description, "Y not found, blocked by permissions");
  assert.equal(result.usedConclude, true);
  assert.equal(worker.calls().length, 2, "should have called worker twice (execute + conclude)");
});

test("evaluator via runSubagent: returns accept verdict", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "X is 42", evidence: ["measured"], source: "explorer", confidence: 0.9 });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const output = await runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  });
  assert.equal(output.kind, "verdict");
  assert.equal(output.verdict.decision, "pass");
});

test("evaluator via runSubagent: returns reject verdict", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "wrong", source: "explorer" });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "deny", reason: "bad" }));

  const output = await runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  });
  assert.equal(output.verdict.decision, "deny");
});

test("evaluator via runSubagent: demote with adjusted confidence", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "partial", source: "explorer", confidence: 0.9 });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "weak", confidence: 0.3 }));

  const output = await runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  });
  assert.equal(output.verdict.decision, "pass");
  assert.equal(output.verdict.confidence, 0.3);
});

test("evaluator via runSubagent: throws on invalid decision", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "x", source: "explorer" });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "maybe", reason: "invalid" }));

  await assert.rejects(runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  }));
});

test("metacog via runSubagent: produces hints", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Metacog Role/i, env("hints", { hints: [{ content: "investigate auth" }] }));

  const output = await runSubagent({
    profile: config.profiles.metacog!, profileId: "metacog",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: metacogExtra("scheduled"),
  });
  assert.equal(output.kind, "hints");
  assert.equal(output.hints.hints.length, 1);
  assert.equal(output.hints.hints[0].content, "investigate auth");
});

test("metacog via runSubagent: can request stop", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Metacog Role/i, env("stop", { reason: "goal met" }));

  const output = await runSubagent({
    profile: config.profiles.metacog!, profileId: "metacog",
    ...roleContext(graph, p), workerPool: worker, config,
    promptExtra: metacogExtra("stagnation"),
  });
  assert.equal(output.kind, "stop");
  assert.equal(output.stop.reason, "goal met");
});

test("role execution rejects direct API workers that cannot read JSON artifacts", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  config.workers.direct = { kind: "api" };
  config.profiles.explorer.runtime.worker = "direct";
  await assert.rejects(runSubagent({
    profile: config.profiles.explorer,
    profileId: "explorer",
    ...roleContext(graph, p),
    workerPool: worker,
    config,
    promptExtra: "test",
  }), /cannot read session JSON artifacts/);
});

test("plannerExtra: with hints renders hint response block", () => {
  const hints = [{ id: "h001", projectId: "p", content: "check auth", creator: "metacog" as const, kind: "direction" as const, createdAt: "" }];
  const text = plannerExtra(hints);
  assert.match(text, /Hints Requiring Response/);
  assert.match(text, /check auth/);
});

test("plannerExtra: with verdicts renders verdict block", () => {
  const verdicts = [{ factId: "f001", verdict: { decision: "deny" as const, reason: "bad" } }];
  const text = plannerExtra(undefined, verdicts);
  assert.match(text, /Recent Evaluator Verdicts/);
  assert.match(text, /reject/);
});

test("plannerExtra: empty input returns empty string", () => {
  const text = plannerExtra();
  assert.equal(text, "");
});

test("explorerExtra: includes intent id and description", () => {
  const source = {
    id: "f001", projectId: "p", description: "verified entry point",
    evidence: ["src/a.ts:1"], source: "explorer" as const,
    confidence: 0.9, status: "pass" as const, createdAt: "",
  };
  const text = explorerExtra("i001", "find bugs", ["f001"], [], [source]);
  assert.match(text, /i001/);
  assert.match(text, /find bugs/);
  assert.match(text, /f001/);
  assert.match(text, /\[0\].*verified entry point/);
});

test("evaluatorExtra: includes candidate id and evidence", () => {
  const candidate = {
    id: "f005", projectId: "p", description: "finding",
    evidence: ["proof1", "proof2"], source: "explorer",
    confidence: 0.8, status: "candidate" as const, createdAt: "",
  };
  const text = evaluatorExtra(candidate);
  assert.match(text, /f005/);
  assert.match(text, /finding/);
  assert.match(text, /proof1/);
});

test("evaluatorExtra renders the producing Intent's ordered source Fact details", () => {
  const source = {
    id: "f001", projectId: "p", description: "verified component export",
    evidence: [], source: "explorer" as const,
    confidence: 0.9, status: "pass" as const, createdAt: "",
  };
  const intent = {
    id: "i002", projectId: "p", description: "trace the exported component",
    creator: "planner" as const, parentFactIds: [source.id], status: "pass" as const,
    dispatchRequested: true, priority: 1, createdAt: "",
  };
  const candidate = {
    id: "f002", projectId: "p", description: "candidate reachability",
    evidence: [], source: "explorer" as const,
    confidence: 0.8, status: "candidate" as const, createdAt: "",
  };
  const text = evaluatorExtra(candidate, undefined, undefined, { intent, sourceFacts: [source] });
  assert.match(text, /Producing Intent and Ordered Sources/);
  assert.match(text, /i002/);
  assert.match(text, /\[0\].*verified component export/);
});

test("metacogExtra: includes trigger", () => {
  const text = metacogExtra("stagnation");
  assert.match(text, /stagnation/);
});

test("contract enforcement: explorer returning verdict is rejected", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "task", creator: "planner" });
  worker.register(/Explorer Role/i, env("verdict", { decision: "pass", reason: "wrong role" }));

  await assert.rejects(
    runSubagent({
      profile: config.profiles.explorer, profileId: "explorer",
      ...roleContext(graph, p), workerPool: worker, config,
      promptExtra: explorerExtra(intent.id, intent.description, [], []),
    }),
    /contract="candidate_fact".*kind="verdict"/,
  );
});

test("contract enforcement: evaluator returning decisions is rejected", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "x", source: "explorer" });
  worker.register(/Evaluator Role/i, env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: null }));

  await assert.rejects(
    runSubagent({
      profile: config.profiles.evaluator, profileId: "evaluator",
      ...roleContext(graph, p), workerPool: worker, config,
      promptExtra: evaluatorExtra(candidate),
    }),
    /contract="verdict".*kind="decisions"/,
  );
});

test("contract enforcement: metacog returning fact is rejected", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Metacog Role/i, env("fact", { description: "should not produce facts", evidence: [], confidence: 0.5 }));

  await assert.rejects(
    runSubagent({
      profile: config.profiles.metacog!, profileId: "metacog",
      ...roleContext(graph, p), workerPool: worker, config,
      promptExtra: metacogExtra("scheduled"),
    }),
    /contract="hints".*kind="fact"/,
  );
});
