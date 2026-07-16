import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyMainDecision, nearDuplicateGoal } from "../dist/agent/decision-applier.js";
import { PermissionChecker } from "../dist/agent/permissions.js";
import { TestGraph } from "./test-graph.ts";
import { minimalConfig, createProject } from "./helper.ts";
import type { MainDecision } from "../dist/agent/contracts.js";
import type { SubagentProfile, Permission } from "../dist/agent/types.js";

function perms(permissions: Permission[]): PermissionChecker {
  const profile: SubagentProfile = {
    role: "planner", runtime: { worker: "mock" },
    prompt: { file: "x.md" }, context: { graphView: "full" },
    permissions, output: { contract: "main_decision" },
  };
  return new PermissionChecker(profile);
}

function decision(partial: Partial<MainDecision>): MainDecision {
  return {
    createIntents: (partial.createIntents ?? []).map((intent) => ({
      ...intent,
      dispatchExplorer: intent.dispatchExplorer ?? true,
    })),
    dispatchExplorerIntentIds: partial.dispatchExplorerIntentIds ?? [],
    stopExplorerIntentIds: partial.stopExplorerIntentIds ?? [],
    failIntents: partial.failIntents ?? [],
    consumeHintIds: partial.consumeHintIds ?? [],
    concludeRun: partial.concludeRun,
  };
}

test("decision-applier: creates intents from createIntents", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "task A" }, { description: "task B" }] }),
    permissions: perms(["create_intent", "create_subagent_explorer"]),
  });
  assert.equal(result.intentsCreated, 2);
  assert.equal(graph.intents(p.id).length, 2);
});

test("decision-applier: planner may create a held Intent and dispatch it later", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "held", dispatchExplorer: false }] }),
    permissions: perms(["create_intent"]),
  });
  const held = graph.intents(p.id)[0]!;
  assert.equal(held.dispatchRequested, false);

  applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ dispatchExplorerIntentIds: [held.id] }),
    permissions: perms(["create_subagent_explorer"]),
  });
  assert.equal(graph.getIntent(p.id, held.id)!.dispatchRequested, true);
});

test("decision-applier: stopExplorer revokes the claim without denying the Intent", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "running", creator: "planner" });
  const claimed = graph.claimIntent(p.id, intent.id, "worker", 300_000);
  const claimedEpoch = claimed.lease!.epoch;
  const run = graph.createSubagentRun(p.id, {
    profileId: "explorer", role: "explorer", workerName: "mock", intentId: intent.id,
  });
  graph.updateSubagentRun(p.id, run.id, { status: "running" });

  const result = applyMainDecision({
    projectId: p.id,
    graph,
    config: minimalConfig(),
    decision: decision({ stopExplorerIntentIds: [intent.id] }),
    permissions: perms(["stop_subagent_explorer"]),
  });

  const stopped = graph.getIntent(p.id, intent.id)!;
  assert.equal(result.explorersStopped, 1);
  assert.equal(stopped.status, "open");
  assert.equal(stopped.dispatchRequested, false);
  assert.ok(stopped.leaseEpoch > claimedEpoch);
  assert.equal(graph.getSubagentRun(p.id, run.id)!.status, "cancelled");
});

test("decision-applier: failing a claimed Intent also requires stop_subagent_explorer", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "running", creator: "planner" });
  graph.claimIntent(p.id, intent.id, "worker", 300_000);

  assert.throws(() => applyMainDecision({
    projectId: p.id,
    graph,
    config: minimalConfig(),
    decision: decision({ failIntents: [{ intentId: intent.id, reason: "redirect" }] }),
    permissions: perms(["fail_intent"]),
  }), /stop_subagent_explorer/);
  assert.equal(graph.getIntent(p.id, intent.id)!.status, "claimed");
});

test("decision-applier: dispatched Intent requires create_subagent_explorer", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ createIntents: [{ description: "run now" }] }),
      permissions: perms(["create_intent"]),
    }),
    /lacks permission "create_subagent_explorer"/,
  );
  assert.equal(graph.intents(p.id).length, 0);
});

test("decision-applier: skips intents matching recorded dead-ends", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "dead path", creator: "planner" });
  graph.failIntent(p.id, intent.id, "proven useless", true);

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "dead path" }, { description: "new path" }] }),
    permissions: perms(["create_intent", "create_subagent_explorer"]),
  });
  assert.equal(result.intentsCreated, 1);
  assert.equal(graph.intents(p.id, "open").length, 1);
  const openDescriptions = graph.intents(p.id, "open").map((i) => i.description);
  assert.ok(!openDescriptions.includes("dead path"), "dead-end intent must NOT be created");
  assert.ok(openDescriptions.includes("new path"), "new path intent must be created");
});

test("decision-applier: fails intents from failIntents", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const i1 = graph.addIntent(p.id, { description: "wrong dir", creator: "planner" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ failIntents: [{ intentId: i1.id, reason: "hint contradicts" }] }),
    permissions: perms(["fail_intent"]),
  });
  assert.equal(result.intentsFailed, 1);
  assert.equal(graph.getIntent(p.id, i1.id)!.status, "deny");
  assert.equal(graph.getIntent(p.id, i1.id)!.killedBy, "planner");
});

test("decision-applier: failing unknown intentId is silently ignored", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ failIntents: [{ intentId: "i999", reason: "nope" }] }),
    permissions: perms(["fail_intent"]),
  });
  assert.equal(result.intentsFailed, 0);
});

test("decision-applier: consumes hints from decision.consumeHintIds", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const h1 = graph.addHint(p.id, { content: "go left", creator: "metacog" });
  const h2 = graph.addHint(p.id, { content: "go right", creator: "metacog" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ consumeHintIds: [h1.id] }),
    permissions: perms([]),
  });
  assert.equal(result.hintsConsumed, 1);
  assert.equal(graph.unconsumedHints(p.id).length, 1);
  assert.equal(graph.unconsumedHints(p.id)[0].id, h2.id);
});

test("decision-applier: does not consume hints the planner did not select", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const h1 = graph.addHint(p.id, { content: "hint", creator: "metacog" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({}),
    permissions: perms([]),
  });
  assert.equal(result.hintsConsumed, 0);
  assert.equal(graph.unconsumedHints(p.id)[0]?.id, h1.id);
});

test("decision-applier: concludeRun creates a finish proposal", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ concludeRun: { description: "goal achieved" } }),
    permissions: perms(["create_end_fact"]),
  });
  assert.equal(result.concluded, true);
  assert.equal(graph.getProject(p.id)!.status, "finish_proposed");
});

test("decision-applier: cannot create new work and an EndFact in one decision", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({
        createIntents: [{ description: "not finished" }],
        concludeRun: { description: "contradictory completion" },
      }),
      permissions: perms(["create_intent", "create_subagent_explorer", "create_end_fact"]),
    }),
    /intents are open or claimed/,
  );
  assert.equal(graph.intents(p.id).length, 0, "the whole planner decision must roll back");
  assert.equal(graph.activeEndFact(p.id), undefined);
});

test("decision-applier: throws PermissionDeniedError on createIntent without permission", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ createIntents: [{ description: "x" }] }),
      permissions: perms([]),
    }),
    /lacks permission "create_intent"/,
  );
});

test("decision-applier: throws PermissionDeniedError on failIntent without permission", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const i1 = graph.addIntent(p.id, { description: "x", creator: "planner" });
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ failIntents: [{ intentId: i1.id, reason: "r" }] }),
      permissions: perms([]),
    }),
    /lacks permission "fail_intent"/,
  );
});

test("decision-applier: throws PermissionDeniedError on concludeRun without permission", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ concludeRun: { description: "done" } }),
      permissions: perms([]),
    }),
    /lacks permission "create_end_fact"/,
  );
});

test("decision-applier: parentFactIds and priority passed through to addIntent", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const f1 = graph.addFact(p.id, { description: "fact", source: "explorer", confidence: 0.9 });
  // Intents may only extend from verified facts (Cairn-minimal edge rule).
  graph.resolveFact(p.id, f1.id, { decision: "pass", reason: "proven", confidence: 0.9 });
  applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "task", parentFactIds: [f1.id], priority: 5 }] }),
    permissions: perms(["create_intent", "create_subagent_explorer"]),
  });
  const intent = graph.intents(p.id)[0];
  assert.deepEqual(intent.parentFactIds, [f1.id]);
  assert.equal(intent.priority, 5);
});

test("decision-applier: empty decision returns all-zero result", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({}),
    permissions: perms([]),
  });
  assert.equal(result.intentsCreated, 0);
  assert.equal(result.intentsFailed, 0);
  assert.equal(result.hintsConsumed, 0);
  assert.equal(result.concluded, false);
});

test("decision-applier: mid-decision permission error rolls back all mutations", () => {
  const graph = new TestGraph();
  const p = createProject(graph);

  const decision: MainDecision = {
    createIntents: [
      { description: "first intent", dispatchExplorer: true },
      { description: "second intent", dispatchExplorer: true },
      { description: "third intent", dispatchExplorer: true },
    ],
    dispatchExplorerIntentIds: [],
    stopExplorerIntentIds: [],
    failIntents: [],
    consumeHintIds: [],
    concludeRun: undefined,
  };

  const checker: PermissionChecker = new PermissionChecker({
    role: "planner",
    runtime: { worker: "mock" },
    prompt: { file: "x.md" },
    context: { graphView: "full" },
    permissions: ["create_intent", "fail_intent", "handle_hint"],
    output: { contract: "main_decision" },
  });

  let callCount = 0;
  const wrapper: PermissionChecker = {
    role: "planner",
    has(p) {
      callCount++;
      if (callCount <= 2) return true;
      return false;
    },
    require(p) {
      callCount++;
      if (callCount > 2) {
        throw { message: `lacks permission "${p}"`, name: "PermissionDeniedError", permission: p };
      }
    },
    requireAny() {},
  } as unknown as PermissionChecker;

  assert.throws(() =>
    applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision,
      permissions: wrapper,
    }),
  );

  assert.equal(graph.intents(p.id).length, 0, "no intents should remain after rollback");
});

test("decision-applier: successful decision is fully persisted", () => {
  const graph = new TestGraph();
  const p = createProject(graph);

  applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({
      createIntents: [{ description: "a" }, { description: "b" }],
    }),
    permissions: perms(["create_intent", "create_subagent_explorer"]),
  });

  assert.equal(graph.intents(p.id).length, 2);
  assert.equal(graph.intents(p.id, "open").length, 2);
});

test("decision-applier: drops near-duplicate intents already in flight", () => {
  const graph = new TestGraph();
  const p = createProject(graph);
  // Pre-existing open intent — a direction already being explored.
  graph.addIntent(p.id, { description: "try the login SQL injection", creator: "planner" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    // First is a filler-word rewording of the existing one (should be dropped);
    // second is genuinely different (should be created).
    decision: decision({
      createIntents: [
        { description: "please attempt SQL injection on the login" },
        { description: "scan the upload endpoint for vulnerabilities" },
      ],
    }),
    permissions: perms(["create_intent", "create_subagent_explorer"]),
  });
  assert.equal(result.intentsCreated, 1, "near-duplicate should be dropped, only the new one created");
  const dupEvent = graph.events(p.id).find((e) => e.type === "planner.duplicate_intent_dropped");
  assert.ok(dupEvent, "a duplicate_intent_dropped event should be logged");
});

test("nearDuplicateGoal: filler-word rewordings match, distinct labels don't", () => {
  // filler-word rewording → duplicate
  assert.ok(nearDuplicateGoal("attempt SQL injection on login", "try login SQL injection"));
  // short placeholder labels are NOT duplicates
  assert.ok(!nearDuplicateGoal("TASK-A", "TASK-B"));
  // blank never matches
  assert.ok(!nearDuplicateGoal("", "something"));
  // genuinely different directions don't match
  assert.ok(!nearDuplicateGoal("scan the web server", "crack the password hash"));
});
