import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../dist/app/agent-runtime.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { TestFederationBus } from "./test-graph.ts";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { minimalConfig, env } from "./helper.ts";

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

function makeRuntime(opts: { workerPool?: MockWorker } = {}) {
  const worker = opts.workerPool ?? new MockWorker();
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));
  const config = minimalConfig();
  const sessionId = randomUUID();
  const runtime = new AgentRuntime(config, {
    baseDir: mkdtempSync(join(tmpdir(), "peak-agent-runtime-")),
    workerPool: worker,
    useHttp: false,
    sessionId,
  });
  return { runtime, worker, config, sessionId };
}

test("agent-runtime: createProject returns a project id", () => {
  const { runtime } = makeRuntime();
  const id = runtime.createProject({ session: "test-session" });
  assert.ok(id);
  assert.equal(typeof id, "string");
});

test("agent-runtime: persistent graph identity requires a UUID before construction", () => {
  const config = minimalConfig();
  assert.throws(
    () => new AgentRuntime(config, { baseDir: "unused", useHttp: false }),
    /requires a UUID sessionId/,
  );
  assert.throws(
    () => new AgentRuntime(config, {
      baseDir: "unused",
      sessionId: "different",
      useHttp: false,
    }),
    /session id must be a UUID/,
  );
});

test("agent-runtime: step drives a single project step", async () => {
  const worker = new MockWorker();
  const { runtime } = makeRuntime({ workerPool: worker });

  worker.register(/automated planning module/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const pid = runtime.createProject({ session: "test-session" });
  const result = await runtime.step(pid);
  assert.ok(result.type === "stepped" || result.type === "completed");
});

test("agent-runtime: run drives to completion", async () => {
  const worker = new MockWorker();
  const { runtime, config } = makeRuntime({ workerPool: worker });

  let round = 0;
  worker.register(/automated planning module/i, () => {
    round++;
    return round === 1 ? decisions([{ description: "TASK" }]) : decisions([], { description: "goal met" });
  });
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  const pid = runtime.createProject({ session: "test-session" });
  const result = await runtime.run(pid, { idlePollMs: 5 });
  assert.equal(result.type, "completed");
});

test("agent-runtime: run returns when the project reaches failed status", async () => {
  const worker = new MockWorker();
  const { runtime, config } = makeRuntime({ workerPool: worker });
  config.profiles.planner!.retry = { maxAttempts: 1, backoffMs: 0 };
  worker.register(/automated planning module/i, "not json");

  const projectId = runtime.createProject({ session: "failed-session" });
  const result = await runtime.run(projectId, { idlePollMs: 1 });

  assert.deepEqual(result, { type: "failed", reason: "project failed" });
  await runtime.close();
});

test("agent-runtime: federated single-session run completes through supervisor barrier", async () => {
  const worker = new MockWorker();
  const config = minimalConfig();
  const sessionId = randomUUID();
  config.federation = {
    scope: "fed-one-group",
  };
  const bus = new TestFederationBus();
  const runtime = new AgentRuntime(config, {
    baseDir: mkdtempSync(join(tmpdir(), "peak-agent-runtime-")),
    workerPool: worker,
    useHttp: false,
    federationBus: bus,
    sessionId,
    federationScope: "fed-one-group",
  });
  let round = 0;
  worker.register(/automated planning module/i, () => {
    round += 1;
    return round === 1
      ? decisions([{ description: "FED-TASK" }])
      : decisions([], { description: "federated goal met" });
  });
  worker.register(/FED-TASK/i, env("fact", { description: "verified", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  const projectId = runtime.createProject({ session: "fed-one" });
  const result = await runtime.run(projectId, { idlePollMs: 1 });
  assert.equal(result.type, "completed");
  assert.equal(runtime.graph.getProject(projectId)?.status, "completed");
  assert.ok(bus.recentBroadcasts(10, "fed-one-group").some((item) => item.factId === "f001"));
  await runtime.close();
  bus.close();
});

test("agent-runtime: rejects a second session/task in the same runtime", async () => {
  const worker = new MockWorker();
  const { runtime, config } = makeRuntime({ workerPool: worker });

  let round = 0;
  worker.register(/automated planning module/i, () => {
    round++;
    return round <= 2 ? decisions([{ description: "TASK" }]) : decisions([], { description: "goal met" });
  });
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "ok" }));

  runtime.createProject({ session: "test-session" });
  assert.throws(
    () => runtime.createProject({ session: "s2" }),
    /separate runtime|one session runtime/,
  );
  const results = await runtime.tick();
  assert.equal(results.length, 1);
});

test("agent-runtime: addDirective injects directive into graph", () => {
  const { runtime } = makeRuntime();
  const pid = runtime.createProject({ session: "test-session" });
  runtime.addDirective(pid, { kind: "hint", payload: "check X" });
  assert.equal(runtime.graph.unconsumedDirectives(pid).length, 1);
});

test("agent-runtime: close does not throw", async () => {
  const { runtime } = makeRuntime();
  await assert.doesNotReject(runtime.close());
});

test("agent-runtime: close aborts in-flight work before releasing the session", async () => {
  const worker = new MockWorker();
  const config = minimalConfig();
  const runtime = new AgentRuntime(config, {
    baseDir: mkdtempSync(join(tmpdir(), "peak-agent-runtime-")),
    workerPool: worker,
    useHttp: false,
    sessionId: randomUUID(),
  });
  worker.register(/automated planning module/i, () => new Promise<string>(() => {}));
  const projectId = runtime.createProject({ session: "closing" });
  const step = runtime.step(projectId);
  await new Promise((resolve) => setTimeout(resolve, 10));

  await Promise.race([
    runtime.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 1_000)),
  ]);
  await step;
});

test("agent-runtime: close interrupts a supervisor run waiting in idle polling", async () => {
  const worker = new MockWorker();
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const config = minimalConfig();
  const sessionId = randomUUID();
  const runtime = new AgentRuntime(config, {
    baseDir: mkdtempSync(join(tmpdir(), "peak-agent-runtime-")),
    workerPool: worker,
    useHttp: false,
    globalSupervisor: supervisor,
    sessionId,
  });
  const projectId = runtime.createProject({ session: "closing-idle-run" });
  supervisor.tick = async () => [];
  const run = runtime.run(projectId, { idlePollMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await runtime.close();
  await assert.rejects(run, /agent runtime is closed/);
  assert.throws(() => runtime.createProject({ session: "closing-idle-run" }), /agent runtime is closed/);
  await assert.rejects(runtime.startHttp(), /agent runtime is closed/);
  supervisor.federationBus.close();
});

test("agent-runtime: close removes its standalone federation registration", async () => {
  const bus = new TestFederationBus();
  const config = minimalConfig();
  const sessionId = randomUUID();
  const runtime = new AgentRuntime(config, {
    baseDir: mkdtempSync(join(tmpdir(), "peak-agent-runtime-")),
    workerPool: new MockWorker(),
    useHttp: false,
    federationBus: bus,
    federationScope: "closing-scope",
    sessionId,
  });
  runtime.createProject({ session: "closing-federation" });
  assert.equal(
    bus.registeredSessions("closing-scope").some((member) => member.sessionId === sessionId),
    true,
  );

  await runtime.close();
  assert.equal(
    bus.registeredSessions("closing-scope").some((member) => member.sessionId === sessionId),
    false,
  );
  bus.close();
});

test("agent-runtime: always uses persistent SQLite", () => {
  const { runtime } = makeRuntime();
  assert.ok(runtime.graph instanceof SqliteGraph);
});

test("agent-runtime: createProject is idempotent for same session", () => {
  const { runtime } = makeRuntime();
  const id1 = runtime.createProject({ session: "test-session" });
  const id2 = runtime.createProject({ session: "test-session" });
  assert.equal(id1, id2);
});

test("agent-runtime: step on unknown project returns failed", async () => {
  const { runtime } = makeRuntime();
  const result = await runtime.step("nonexistent");
  assert.equal(result.type, "failed");
});
