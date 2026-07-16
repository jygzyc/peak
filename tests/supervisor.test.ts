import { test } from "node:test";
import { strict as assert } from "node:assert";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { TestFederationBus, TestGraph } from "./test-graph.ts";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("GlobalSupervisor: register/unregister sessions", () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const loop = new SessionLoop(graph, worker, config);

  sup.register("s1", loop);
  assert.equal(sup.listSessions().length, 1);
  assert.equal(sup.get("s1"), loop);

  sup.unregister("s1");
  assert.equal(sup.listSessions().length, 0);
});

test("GlobalSupervisor: register throws on duplicate id", () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const loop = new SessionLoop(graph, worker, config);

  sup.register("s1", loop);
  assert.throws(() => sup.register("s1", loop), /already registered/);
});

test("GlobalSupervisor: failed governor binding rolls back federation membership", () => {
  const first = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const second = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const loop = new SessionLoop(new TestGraph(), new MockWorker(), minimalConfig());
  first.register("owned", loop, { scope: "first" });
  first.unregister("owned");

  assert.throws(
    () => second.register("owned", loop, { scope: "second" }),
    /resource governor is already bound/,
  );
  assert.equal(second.listSessions().length, 0);
  assert.equal(
    second.federationBus.registeredSessions("second").find((member) => member.sessionId === "owned")?.memberStatus,
    "left",
  );
});

test("GlobalSupervisor: tick steps all registered sessions", async () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const graph1 = new TestGraph();
  const graph2 = new TestGraph();
  const worker1 = new MockWorker();
  const worker2 = new MockWorker();
  const config1 = minimalConfig();
  const config2 = minimalConfig();
  const p1 = createProject(graph1, { session: "sess1" });
  const p2 = createProject(graph2, { session: "sess2" });
  worker1.register(/automated planning module/i, decisions([], { description: "session 1 done" }));
  worker2.register(/automated planning module/i, decisions([], { description: "session 2 done" }));

  const loop1 = new SessionLoop(graph1, worker1, config1);
  const loop2 = new SessionLoop(graph2, worker2, config2);
  sup.register("sess1", loop1, { projectId: p1.id, scope: "group-a" });
  sup.register("sess2", loop2, { projectId: p2.id, scope: "group-a" });

  const results = await sup.tick();
  assert.ok(results.every((result) => result.result.type === "completed"));
  assert.equal(graph1.getProject(p1.id)!.status, "completed");
  assert.equal(graph2.getProject(p2.id)!.status, "completed");
});

test("GlobalSupervisor: pending broadcast blocks completion until target evaluator advances cursor", async () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const graph1 = new TestGraph();
  const graph2 = new TestGraph();
  const worker1 = new MockWorker();
  const worker2 = new MockWorker();
  const config1 = minimalConfig();
  const config2 = minimalConfig();
  const p1 = createProject(graph1, { session: "sess1" });
  const p2 = createProject(graph2, { session: "sess2" });
  worker1.register(/automated planning module/i, decisions([], { description: "session 1 done" }));
  worker2.register(/automated planning module/i, decisions([], { description: "session 2 done" }));
  let attempts = 0;
  worker2.register(/Cross-session FactBroadcast Under Review/i, () => {
    attempts += 1;
    return attempts === 1
      ? "not-json"
      : env("broadcast_assessment", { decision: "relevant", reason: "same target" });
  });

  const loop1 = new SessionLoop(graph1, worker1, config1);
  const loop2 = new SessionLoop(graph2, worker2, config2);
  sup.register("sess1", loop1, { projectId: p1.id, scope: "group-a" });
  sup.register("sess2", loop2, { projectId: p2.id, scope: "group-a" });
  sup.federationBus.publishInsight(
    "fact",
    { sessionId: "sess1", projectId: p1.id, factId: "f1" },
    "shared finding",
    0.9,
    undefined,
    { id: "fact:sess1:p1:f1", scope: "group-a" },
  );

  await sup.tick();
  assert.equal(graph1.getProject(p1.id)!.status, "finish_proposed");
  assert.equal(graph2.getProject(p2.id)!.status, "finish_proposed");
  assert.equal(sup.federationBus.hasPendingDeliveries("group-a"), true);

  await sup.tick();
  assert.equal(sup.federationBus.hasPendingDeliveries("group-a"), false);
  assert.equal(graph1.getProject(p1.id)!.status, "completed");
  assert.equal(graph2.getProject(p2.id)!.status, "completed");
});

test("GlobalSupervisor: a declared but unregistered session blocks task-group completion", async () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  const graph = new TestGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.federation = {
    scope: "declared-group",
    members: ["sess1", "sess2"],
  };
  const project = createProject(graph, { session: "sess1" });
  worker.register(/automated planning module/i, decisions([], { description: "session 1 done" }));
  const loop = new SessionLoop(graph, worker, config, {
    federationBus: sup.federationBus,
    sessionId: "sess1",
    federationScope: "declared-group",
  });
  sup.register("sess1", loop, { projectId: project.id, scope: "declared-group" });

  await sup.tick();

  assert.equal(graph.getProject(project.id)?.status, "finish_proposed");
  assert.equal(sup.federationBus.taskGroup("declared-group")?.status, "running");
  assert.equal(
    sup.federationBus.registeredSessions("declared-group").find((member) => member.sessionId === "sess2")?.memberStatus,
    "expected",
  );
});

test("GlobalSupervisor: owns a FederationBus", () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus() });
  assert.ok(sup.federationBus);
  sup.federationBus.publishInsight(
    "fact",
    { sessionId: "s1", projectId: "p1", factId: "f1" },
    "test", 0.5,
  );
  assert.equal(sup.federationBus.recentInsights().length, 1);
});

test("GlobalSupervisor: globalMaxConcurrent bounds concurrent session ticks", async () => {
  const sup = new GlobalSupervisor({ federationBus: new TestFederationBus(), globalMaxConcurrent: 2 });
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  for (let i = 0; i < 4; i++) {
    sup.register(`s${i}`, {
      projectIds: () => [],
      taskGroupScope: () => "default",
      setFederation: (bus, sessionId, scope) => bus.registerSession(sessionId, scope),
      unsetFederation: (bus, sessionId) => bus.unregisterSession(sessionId),
      setResourceGovernor: () => {},
      tick: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return [{ type: "idle", reason: "test" }];
      },
    } as SessionLoop);
  }

  const ticking = sup.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(peak, 2);
  release();
  await ticking;
});
