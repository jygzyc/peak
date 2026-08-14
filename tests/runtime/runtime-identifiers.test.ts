import assert from "node:assert/strict";
import { test } from "node:test";
import { customProfileDigest } from "../../dist/utils/types.js";
import { localTimestamp } from "../../dist/graph/api.js";
import { ExecutionRegistry } from "../../dist/runtime/execution-registry.js";
import { budgetGraphView, GRAPH_VIEW_MAX_BYTES } from "../../dist/runtime/task-executor.js";

test("custom profile digest, local timestamps, and execution ids are stable", () => {
  assert.equal(customProfileDigest({
    description: "Use for research.",
    prompt: "Collect primary evidence.",
    skills: [],
  }), "b4814cdb3727f614");
  assert.equal(localTimestamp(new Date(2026, 6, 31, 18, 5, 12, 123)), "20260731T180512.123");

  const registry = new ExecutionRegistry();
  const ids = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const executionId = registry.createId();
    assert.match(executionId, /^[0-9a-f]{8}$/);
    assert.equal(ids.has(executionId), false);
    ids.add(executionId);
    registry.add({ executionId, projectId: "project", kind: "plan", controller: new AbortController() });
  }
});

test("Graph view budgeting is deterministic and reports omissions", () => {
  const view = { project: { id: "project" }, items: Array.from({ length: 400 }, (_, index) => ({
    id: index,
    description: `${String(index).padStart(3, "0")}:${"x".repeat(900)}`,
  })) };
  const first = budgetGraphView(view, ["items"]);
  const second = budgetGraphView(view, ["items"]);
  assert.deepEqual(first, second);
  assert.equal(first.truncated, true);
  assert.ok(first.omitted.items! > 0);
  assert.equal(first.items[0]?.id, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(first, null, 2), "utf8") <= GRAPH_VIEW_MAX_BYTES);
});
