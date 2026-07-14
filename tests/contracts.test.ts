import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  validateMainDecision,
  validateCandidateFact,
  validateVerdict,
  validateHints,
  validateStop,
} from "../dist/agent/contracts.js";
import { parseEnvelope } from "../dist/agent/parse-envelope.js";

function env(kind: string, data: unknown): ReturnType<typeof parseEnvelope> {
  return parseEnvelope(JSON.stringify({ kind, data }), "test");
}

test("contracts: validateMainDecision parses createIntents with from+priority", () => {
  const d = validateMainDecision(env("decisions", {
    createIntents: [{ description: "do X", from: ["f001"], priority: 2 }],
    failIntents: [{ intentId: "i002", reason: "wrong" }],
    concludeRun: null,
  }));
  assert.equal(d.createIntents.length, 1);
  assert.equal(d.createIntents[0].description, "do X");
  assert.deepEqual(d.createIntents[0].parentFactIds, ["f001"]);
  assert.equal(d.createIntents[0].priority, 2);
  assert.equal(d.failIntents[0].intentId, "i002");
  assert.equal(d.concludeRun, undefined);
});

test("contracts: validateMainDecision parses concludeRun", () => {
  const d = validateMainDecision(env("decisions", {
    createIntents: [], failIntents: [],
    concludeRun: { description: "goal met" },
  }));
  assert.equal(d.concludeRun!.description, "goal met");
});

test("contracts: validateMainDecision honors planner consumeHints selection", () => {
  // Previously consumeHintIds was hard-coded to [] (docs 03-agent.md §3.3) —
  // the planner's selection was discarded entirely.
  const d = validateMainDecision(env("decisions", {
    createIntents: [], failIntents: [],
    consumeHints: ["h001", "h002"],
    concludeRun: null,
  }));
  assert.deepEqual(d.consumeHintIds, ["h001", "h002"]);
});

test("contracts: validateMainDecision filters non-string consumeHints entries", () => {
  const d = validateMainDecision(env("decisions", {
    createIntents: [], failIntents: [],
    consumeHints: ["h001", 123, null, "", "h003"],
    concludeRun: null,
  }));
  assert.deepEqual(d.consumeHintIds, ["h001", "h003"]);
});

test("contracts: validateMainDecision defaults consumeHintIds to [] when absent", () => {
  const d = validateMainDecision(env("decisions", {
    createIntents: [], failIntents: [],
    concludeRun: null,
  }));
  assert.deepEqual(d.consumeHintIds, []);
});

test("contracts: validateCandidateFact defaults confidence to 0.7", () => {
  const c = validateCandidateFact(env("fact", { description: "x", evidence: [] }), "explorer");
  assert.equal(c.confidence, 0.7);
});

test("contracts: validateCandidateFact parses evidence array", () => {
  const c = validateCandidateFact(env("fact", { description: "x", evidence: ["a", "b"], confidence: 0.9 }), "explorer");
  assert.deepEqual(c.evidence, ["a", "b"]);
  assert.equal(c.confidence, 0.9);
});

test("contracts: validateVerdict accepts accept/reject/defer", () => {
  for (const decision of ["pass", "deny", "pending"] as const) {
    const v = validateVerdict(env("verdict", { decision, reason: "r" }), "evaluator");
    assert.equal(v.decision, decision);
  }
});

test("contracts: validateVerdict parses deferred prerequisites", () => {
  const v = validateVerdict(env("verdict", {
    decision: "pending", reason: "needs precondition", requiredConditions: ["login", "token"],
  }), "evaluator");
  assert.equal(v.decision, "pending");
  assert.deepEqual(v.requiredConditions, ["login", "token"]);
});

test("contracts: validateVerdict throws on invalid decision", () => {
  assert.throws(() => validateVerdict(env("verdict", { decision: "maybe", reason: "r" }), "evaluator"));
});

test("contracts: validateHints maps creator", () => {
  const { hints } = validateHints(env("hints", { hints: [{ content: "go left" }] }), "metacog", "metacog");
  assert.equal(hints.length, 1);
  assert.equal(hints[0].content, "go left");
  assert.equal(hints[0].creator, "metacog");
});

test("contracts: validateStop extracts reason", () => {
  const { reason } = validateStop(env("stop", { reason: "goal met" }), "metacog");
  assert.equal(reason, "goal met");
});
