import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRuntimeFactory } from "../dist/app/session-runtime-factory.js";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { TestFederationBus } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { env, minimalConfig } from "./helper.ts";

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("SessionRuntimeFactory creates and registers one complete runtime per session", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "peak-runtime-factory-"));
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus(), globalMaxConcurrent: 2 });
  const factory = new SessionRuntimeFactory({
    baseDir,
    workerPool: new MockWorker(),
    supervisor,
  });

  try {
    const configA = minimalConfig();
    configA.task.session = "factory-a";
    const configB = minimalConfig();
    configB.task.session = "factory-b";

    const a = await factory.create(configA);
    const b = await factory.create(configB);

    assert.notEqual(a.runtime.graph, b.runtime.graph);
    assert.equal(a.runtime.graph.listProjects().length, 1);
    assert.equal(b.runtime.graph.listProjects().length, 1);
    assert.ok(a.runtime.metacogSupervisor);
    assert.ok(b.runtime.metacogSupervisor);
    assert.equal(supervisor.listSessions().length, 2);
    assert.deepEqual(
      supervisor.listSessions().map((session) => session.scope).sort(),
      ["factory-a", "factory-b"],
      "sessions without an explicit federation scope must not share a task group",
    );
    assert.equal(supervisor.get("factory-a"), a.runtime.sessionLoop);
    assert.equal(supervisor.get("factory-b"), b.runtime.sessionLoop);
    assert.equal(a.runtime.graph.getProject(a.projectId)?.session, "factory-a");
    assert.equal(b.runtime.graph.getProject(b.projectId)?.session, "factory-b");
  } finally {
    await factory.close();
    supervisor.federationBus.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SessionRuntimeFactory rejects duplicate session ownership", async () => {
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const baseDir = mkdtempSync(join(tmpdir(), "peak-runtime-duplicate-"));
  const factory = new SessionRuntimeFactory({
    baseDir,
    workerPool: new MockWorker(),
    supervisor,
  });
  const config = minimalConfig();
  config.task.session = "factory-duplicate";

  try {
    await factory.create(config);
    await assert.rejects(factory.create(config), /session already exists/);
  } finally {
    await factory.close();
    supervisor.federationBus.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("factory-created runtime.run reuses its bound supervisor and governor", async () => {
  const worker = new MockWorker();
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus(), globalMaxConcurrent: 1 });
  const baseDir = mkdtempSync(join(tmpdir(), "peak-runtime-run-"));
  const factory = new SessionRuntimeFactory({ baseDir, workerPool: worker, supervisor });
  const config = minimalConfig();
  config.task.session = "factory-run";
  config.federation = {
    scope: "factory-run-scope",
    members: ["factory-run"],
  };
  let plannerRound = 0;
  worker.register(/automated planning module/i, () => {
    plannerRound += 1;
    return plannerRound === 1
      ? decisions([{ description: "FACTORY-WORK" }])
      : decisions([], { description: "factory goal proved" });
  });
  worker.register(/FACTORY-WORK/i, env("fact", {
    description: "factory result",
    evidence: ["factory fixture"],
    confidence: 0.9,
  }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "pass", reason: "verified" }));
  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  try {
    const created = await factory.create(config);
    const result = await created.runtime.run(created.projectId, { idlePollMs: 1 });

    assert.equal(result.type, "completed");
    assert.equal(supervisor.listSessions().length, 1, "run() must not register a second control plane");
    assert.equal(supervisor.resourceGovernor.activeCount, 0);
  } finally {
    await factory.close();
    supervisor.federationBus.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SessionRuntimeFactory owns one HTTP server for every registered session", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "peak-runtime-http-"));
  const supervisor = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const factory = new SessionRuntimeFactory({
    baseDir,
    workerPool: new MockWorker(),
    supervisor,
    useHttp: true,
  });
  const configA = minimalConfig();
  configA.task.session = "http-a";
  const configB = minimalConfig();
  configB.task.session = "http-b";

  try {
    const a = await factory.create(configA);
    const b = await factory.create(configB);
    assert.equal(a.runtime.httpServer, undefined);
    assert.equal(b.runtime.httpServer, undefined);
    assert.equal(factory.httpServer?.listSessions().length, 2);

    await factory.startHttp({ port: 0 });
    const response = await fetch(`http://127.0.0.1:${factory.httpServer!.port}/api/sessions`, {
      method: "POST",
    });
    const sessions = await response.json() as Array<{ sessionId: string }>;
    assert.deepEqual(sessions.map((item) => item.sessionId), ["http-a", "http-b"]);
  } finally {
    await factory.close();
    assert.equal(factory.httpServer?.port, 0);
    supervisor.federationBus.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SessionRuntimeFactory cannot restart HTTP after terminal close", async () => {
  const factory = new SessionRuntimeFactory({
    baseDir: mkdtempSync(join(tmpdir(), "peak-runtime-closed-")),
    useHttp: true,
  });
  await factory.close();
  assert.throws(() => factory.startHttp({ port: 0 }), /factory is closed/);
});
