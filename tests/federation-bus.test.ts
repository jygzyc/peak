import { test } from "node:test";
import { strict as assert } from "node:assert";
import { FederationBus } from "../dist/graph/federation-bus.js";
import { appendGraphOperation } from "../dist/server/graph-operation-log.js";
import { createProject } from "./helper.ts";
import { TestGraph } from "./test-graph.ts";

function setup() {
  const left = new TestGraph();
  const right = new TestGraph();
  const leftProject = createProject(left, { session: "left" });
  const rightProject = createProject(right, { session: "right" });
  const fact = left.addFact(leftProject.id, {
    description: "verified source fact",
    evidence: ["fixture"],
    source: "explorer",
  });
  left.resolveFact(leftProject.id, fact.id, { decision: "pass", reason: "evidence verified" });
  const bus = new FederationBus();
  bus.registerSession(leftProject.sessionId, "group", leftProject.id, left);
  bus.registerSession(rightProject.sessionId, "group", rightProject.id, right);
  return { bus, left, right, leftProject, rightProject, fact };
}

test("FederationBus carries only sessionId, factId, and reason", () => {
  const state = setup();
  const broadcast = state.bus.publish({
    sessionId: state.leftProject.sessionId,
    factId: state.fact.id,
    reason: "evidence verified",
  });

  assert.deepEqual(broadcast, {
    sessionId: state.leftProject.sessionId,
    factId: state.fact.id,
    reason: "evidence verified",
  });
  assert.equal(state.bus.sourceFact(broadcast)?.description, "verified source fact");
  assert.deepEqual(state.bus.pendingForSession(state.rightProject.sessionId), [broadcast]);
  state.bus.markHandled(state.rightProject.sessionId, broadcast);
  assert.deepEqual(state.bus.pendingForSession(state.rightProject.sessionId), []);
});

test("FederationBus rebuilds sends and receives from Session main.log", () => {
  const state = setup();
  appendGraphOperation(state.leftProject, "metacog", "send_fact_broadcast", {
    factId: state.fact.id,
    reason: "evidence verified",
  });
  appendGraphOperation(state.rightProject, "evaluator", "receive_fact_broadcast", {
    sourceSessionId: state.leftProject.sessionId,
    factId: state.fact.id,
    reason: "evidence verified",
    decision: "relevant",
  });

  const rebuilt = new FederationBus();
  rebuilt.registerSession(state.leftProject.sessionId, "group", state.leftProject.id, state.left);
  rebuilt.registerSession(state.rightProject.sessionId, "group", state.rightProject.id, state.right);
  assert.equal(rebuilt.recentBroadcasts().length, 1);
  assert.equal(rebuilt.pendingForSession(state.rightProject.sessionId).length, 0);
});

test("task group waits until every Fact broadcast is handled", () => {
  const state = setup();
  state.bus.publish({
    sessionId: state.leftProject.sessionId,
    factId: state.fact.id,
    reason: "evidence verified",
  });
  state.bus.setSessionFinishReady(state.leftProject.sessionId, state.leftProject.id, true);
  state.bus.setSessionFinishReady(state.rightProject.sessionId, state.rightProject.id, true);
  assert.equal(state.bus.tryCompleteScope("group"), false);
  const broadcast = state.bus.pendingForSession(state.rightProject.sessionId)[0]!;
  state.bus.markHandled(state.rightProject.sessionId, broadcast);
  assert.equal(state.bus.tryCompleteScope("group"), true);
});
