import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { roleLogs, createProject, env, minimalConfig } from "./helper.ts";

test("SessionLoop distributes Intents across configured explorer roles and workers", async () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  for (let index = 0; index < 6; index += 1) {
    graph.addIntent(project.id, {
      description: `inspect custom lane ${index}`,
      creator: "planner",
      dispatchRequested: true,
    });
  }
  const config = minimalConfig();
  const explorer = config.profiles.explorer!;
  delete config.profiles.explorer;
  config.profiles.explorer_gather = {
    ...explorer,
    role: "explorer",
    runtime: { worker: "fast" },
  };
  config.profiles.explorer_analysis = {
    ...config.profiles.explorer_gather,
    runtime: { worker: "deep" },
  };
  config.workers.fast = { type: "opencode" };
  config.workers.deep = { type: "codex" };
  config.scheduler = { maxConcurrent: 6, refillPerTick: 6 };
  const worker = new MockWorker();
  worker.register(/automated planning module/i, env("decisions", {
    createIntents: [], failIntents: [], consumeHints: [], concludeRun: null,
  }));
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

  const explorerCalls = worker.calls().filter((call) => call.prompt.includes("# Explorer Role"));
  assert.equal(explorerCalls.length, 6);
  assert.deepEqual(new Set(explorerCalls.map((call) => call.workerName)), new Set(["fast", "deep"]));
  assert.deepEqual(
    new Set((await roleLogs(project)).filter((entry) => entry.kind === "output").map((entry) => entry.role)),
    new Set(["explorer_gather", "explorer_analysis", "evaluator"]),
  );
  assert.equal(graph.facts(project.id, "pass").length, 6);
  const operations = readFileSync(join(project.sessionDir, "logs", "main.log"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { role: string; operation: string });
  assert.equal(operations.filter((entry) => entry.role.startsWith("explorer_") && entry.operation === "write_candidate_fact").length, 6);
  assert.equal(operations.filter((entry) => entry.role === "evaluator" && entry.operation === "change_fact").length, 6);
});

test("SessionLoop rejects config without every initial protocol role", () => {
  const graph = new TestGraph();
  const project = createProject(graph);
  graph.addIntent(project.id, { description: "work", creator: "planner", dispatchRequested: true });
  const config = minimalConfig();
  delete config.profiles.explorer;
  assert.throws(() => new SessionLoop(graph, new MockWorker(), config), /explorer role is not configured/);
});
