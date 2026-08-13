import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActiveExecution } from "../../dist/runtime/execution-registry.js";
import { ExecutionRegistry } from "../../dist/runtime/execution-registry.js";
import type { TaskType } from "../../dist/utils/types.js";

function execution(overrides: Partial<ActiveExecution> = {}): ActiveExecution {
  return {
    executionId: overrides.executionId ?? Math.random().toString(16).slice(2, 10),
    projectId: "p1",
    kind: "execute" as TaskType,
    startedAt: Date.now(),
    controller: new AbortController(),
    ...overrides,
  };
}

test("count and has filter by project, kind, and intent", () => {
  const registry = new ExecutionRegistry();
  registry.add(execution({ executionId: "e1", projectId: "p1", kind: "plan" }));
  registry.add(execution({ executionId: "e2", projectId: "p1", kind: "execute", intentId: "i1" }));
  registry.add(execution({ executionId: "e3", projectId: "p2", kind: "execute" }));
  assert.equal(registry.count(), 3);
  assert.equal(registry.count("p1"), 2);
  assert.equal(registry.count("p1", "execute"), 1);
  assert.equal(registry.count("p2", "plan"), 0);
  assert.ok(registry.has("p1", "execute", "i1"));
  assert.ok(!registry.has("p1", "execute", "i2"));
  assert.ok(!registry.has("p1", "execute"), "has matches the intentId exactly, including undefined");
  registry.remove("e2");
  assert.equal(registry.count("p1", "execute"), 0);
});

test("snapshot exposes an immutable DTO without internal handles", () => {
  const registry = new ExecutionRegistry();
  registry.add(execution({ executionId: "e1", projectId: "p1", kind: "execute", startedAt: 1_700_000_000_000 }));
  registry.add(execution({ executionId: "e2", projectId: "p2", kind: "plan", workerName: "w", deadlineAt: 1_700_000_060_000 }));
  const [first] = registry.snapshot("p1");
  assert.deepEqual(first, {
    executionId: "e1",
    projectId: "p1",
    kind: "execute",
    intentId: null,
    workerName: null,
    processId: null,
    startedAt: first!.startedAt,
    deadlineAt: null,
  });
  assert.ok(!("controller" in first!), "snapshots never leak the AbortController");
  assert.match(first!.startedAt, /^\d{8}T\d{6}\.\d{3}$/, "startedAt is a local timestamp string");
  const all = registry.snapshot();
  assert.equal(all.length, 2);
  assert.equal(all.find((item) => item.executionId === "e2")?.workerName, "w");
});

test("createId generates unique ids and setProcessId backfills the child pid", () => {
  const registry = new ExecutionRegistry();
  const id = registry.createId();
  assert.match(id, /^[0-9a-f]{8}$/);
  registry.add(execution({ executionId: id }));
  assert.notEqual(registry.createId(), id);
  registry.setProcessId(id, 4242);
  assert.equal(registry.snapshot()[0]?.processId, 4242);
  registry.setProcessId("missing", 1); // no-op for unknown executions
});

test("cancelProject aborts only that project; cancelAll aborts everything", () => {
  const registry = new ExecutionRegistry();
  const mine = execution({ executionId: "e1", projectId: "p1" });
  const other = execution({ executionId: "e2", projectId: "p2" });
  registry.add(mine);
  registry.add(other);
  registry.cancelProject("p1");
  assert.ok(mine.controller.signal.aborted);
  assert.ok(!other.controller.signal.aborted);
  registry.cancelAll();
  assert.ok(other.controller.signal.aborted);
});

test("waitForEmpty resolves once the registry drains and times out otherwise", async () => {
  const registry = new ExecutionRegistry();
  await registry.waitForEmpty(50); // already empty

  const item = execution({ executionId: "e1" });
  registry.add(item);
  const drained = registry.waitForEmpty(1_000);
  setTimeout(() => registry.remove("e1"), 10);
  await drained;

  registry.add(execution({ executionId: "e2" }));
  await assert.rejects(registry.waitForEmpty(50), /timed out waiting for 1 execution/);
});
