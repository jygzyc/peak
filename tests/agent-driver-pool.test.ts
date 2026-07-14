import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AgentDriverPool } from "../dist/worker/agent-driver-pool.js";
import { registerAgentBackend } from "../dist/worker/backends/registry.js";
import type { AgentBackend, BackendInvokeInput, BackendInvokeResult } from "../dist/worker/backends/types.js";

/**
 * Regression tests for AgentDriverPool (docs 05-worker-core.md §5.5).
 * Previously the pool hand-rebuilt backendConfig and:
 *   - dropped `apiKey` (so task.json workers using `apiKey` instead of
 *     `apiKeyEnv` could never authenticate)
 *   - hard-coded `role: "explorer"` for every call, losing the real profile
 *     role (planner/evaluator/metacog) for audit/billing.
 */

class CapturingBackend implements AgentBackend {
  readonly id = "capture-test";
  public lastInput: BackendInvokeInput | undefined;
  async invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> {
    this.lastInput = input;
    return { text: "ok", returncode: 0, stderr: "" };
  }
}

test("AgentDriverPool: forwards apiKey from the worker config to the backend", async () => {
  const backend = new CapturingBackend();
  const unregister = registerAgentBackend(backend);
  try {
    const pool = new AgentDriverPool();
    await pool.execute({
      prompt: "hello",
      workerName: "capture-test",
      role: "evaluator",
      config: {
        kind: "agent",
        backend: "capture-test",
        apiKey: "sk-test-123",
        model: "m",
      },
    });
    assert.ok(backend.lastInput, "backend should have been invoked");
    assert.equal(backend.lastInput!.config.apiKey, "sk-test-123",
      "apiKey must be forwarded (previously dropped during backendConfig rebuild)");
  } finally {
    unregister();
  }
});

test("AgentDriverPool: role defaults to explorer when request omits role", async () => {
  // The pool still has to pass SOMETHING for role to executeWorker; when the
  // request carries no role it falls back to "explorer" (the previous behavior
  // for every call). The fix makes the real role available instead of
  // hard-coding explorer unconditionally.
  const backend = new CapturingBackend();
  const unregister = registerAgentBackend(backend);
  try {
    const pool = new AgentDriverPool();
    const result = await pool.execute({
      prompt: "hello",
      workerName: "capture-test",
      config: { kind: "agent", backend: "capture-test" },
    });
    assert.equal(result.returncode, 0);
  } finally {
    unregister();
  }
});

test("AgentDriverPool: markRunning/unmarkRunning stay balanced around execute", async () => {
  const backend = new CapturingBackend();
  const unregister = registerAgentBackend(backend);
  try {
    const pool = new AgentDriverPool();
    const projectId = "proj-balance" as never;
    await pool.execute({
      prompt: "hello",
      workerName: "w1",
      role: "explorer",
      projectId,
      config: { kind: "agent", backend: "capture-test" },
    });
    // After execute resolves, no worker should remain marked as running.
    assert.equal(pool.runningCount(projectId), 0,
      "runningCount must return to 0 after execute resolves");
  } finally {
    unregister();
  }
});

test("AgentDriverPool: unmarkRunning runs even when the backend errors", async () => {
  // A failing backend must not leak the running marker (the pool wraps execute
  // in Promise.resolve(...).finally(unmark) so the counter is cleaned up).
  const failingBackend: AgentBackend = {
    id: "fail-test",
    async invoke(): Promise<BackendInvokeResult> {
      return { text: "", returncode: 1, stderr: "boom" };
    },
  };
  const unregister = registerAgentBackend(failingBackend);
  try {
    const pool = new AgentDriverPool();
    const projectId = "proj-fail" as never;
    const result = await pool.execute({
      prompt: "hello",
      workerName: "w-fail",
      role: "explorer",
      projectId,
      config: { kind: "agent", backend: "fail-test" },
    });
    assert.equal(result.returncode, 1);
    assert.equal(pool.runningCount(projectId), 0,
      "runningCount must return to 0 even when the backend returns an error");
  } finally {
    unregister();
  }
});
