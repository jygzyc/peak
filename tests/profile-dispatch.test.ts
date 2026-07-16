import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { createProject, env, minimalConfig } from "./helper.ts";

test("SessionLoop dispatches configured custom explorer/evaluator profile bindings", async () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  graph.addIntent(project.id, { description: "inspect custom lane", creator: "planner", dispatchRequested: true });
  const config = minimalConfig();
  config.profiles["source-finder"] = {
    ...config.profiles.explorer,
    runtime: { ...config.profiles.explorer.runtime },
  };
  config.profiles["strict-reviewer"] = {
    ...config.profiles.evaluator,
    runtime: { ...config.profiles.evaluator.runtime },
  };
  config.control = {
    ...config.control,
    explorerProfile: "source-finder",
    evaluatorProfile: "strict-reviewer",
  };
  const worker = new MockWorker();
  worker.register(/# Explorer Role/i, env("fact", {
    description: "custom profile fact",
    evidence: ["fixture"],
    confidence: 0.9,
  }));
  worker.register(/# Evaluator Role/i, env("verdict", {
    decision: "pass",
    reason: "strictly verified",
  }));

  await new SessionLoop(graph, worker, config).step(project.id);

  assert.equal(graph.subagentRuns(project.id, { profileId: "source-finder" }).length, 1);
  assert.equal(graph.subagentRuns(project.id, { profileId: "strict-reviewer" }).length, 1);
  assert.equal(graph.facts(project.id, "pass").length, 1);
});

test("SessionLoop rejects a control binding whose profile has the wrong protocol role", async () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  graph.addIntent(project.id, { description: "work", creator: "planner", dispatchRequested: true });
  const config = minimalConfig();
  config.control = { ...config.control, explorerProfile: "evaluator" };
  await assert.rejects(
    new SessionLoop(graph, new MockWorker(), config).step(project.id),
    /expected "explorer"/,
  );
});
