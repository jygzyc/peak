import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PermissionChecker, PermissionDeniedError } from "../dist/agent/permissions.js";
import type { SubagentProfile } from "../dist/agent/types.js";
import { BUILTIN_PERMISSIONS } from "../dist/agent/types.js";

function profile(permissions: string[]): SubagentProfile {
  return { role: "test", runtime: { worker: "mock" }, permissions: permissions as never };
}

test("PermissionChecker: has returns true for granted permissions", () => {
  const checker = new PermissionChecker(profile(["create_intent", "create_hint"]));
  assert.equal(checker.has("create_intent"), true);
  assert.equal(checker.has("create_hint"), true);
});

test("PermissionChecker: has returns false for missing permissions", () => {
  const checker = new PermissionChecker(profile(["create_intent"]));
  assert.equal(checker.has("change_fact"), false);
});

test("PermissionChecker: require throws PermissionDeniedError when missing", () => {
  const checker = new PermissionChecker(profile(["create_intent"]));
  assert.throws(
    () => checker.require("change_fact"),
    (err: unknown) => err instanceof PermissionDeniedError && err.permission === "change_fact",
  );
});

test("PermissionChecker: require passes silently when granted", () => {
  const checker = new PermissionChecker(profile(["create_intent"]));
  assert.doesNotThrow(() => checker.require("create_intent"));
});

test("PermissionChecker: requireAny passes if any permission is granted", () => {
  const checker = new PermissionChecker(profile(["write_candidate_fact"]));
  assert.doesNotThrow(() => checker.requireAny("change_fact", "write_candidate_fact"));
  assert.throws(() => checker.requireAny("change_fact", "create_end_fact"));
});

test("builtin role capabilities match the first-version protocol", () => {
  assert.deepEqual(BUILTIN_PERMISSIONS, {
    planner: [
      "create_intent", "fail_intent", "handle_hint", "create_subagent_explorer",
      "stop_subagent_explorer", "create_end_fact",
    ],
    explorer: ["handle_intent", "write_candidate_fact"],
    evaluator: ["change_fact", "receive_fact_broadcast"],
    metacog: ["create_hint", "get_graph", "send_fact_broadcast"],
  });
});
