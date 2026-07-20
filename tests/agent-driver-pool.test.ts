import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AgentDriverPool } from "../dist/worker/agent-driver-pool.js";
import { BaseWorker } from "../dist/worker/backends/subprocess.js";
import { registerWorker } from "../dist/worker/registry.js";
import type { WorkerRequest, WorkerResult } from "../dist/worker/worker-runtime.js";
import { minimalConfig } from "./helper.ts";

class CapturingWorker extends BaseWorker {
  readonly type = "opencode";
  lastInput?: WorkerRequest;

  override execute(input: WorkerRequest): Promise<WorkerResult> {
    this.lastInput = input;
    return Promise.resolve({ text: "ok", returncode: 0, stderr: "" });
  }

  buildArgv() {
    return { argv: ["unused"] };
  }
}

test("AgentDriverPool passes the complete Worker configuration to BaseWorker", async () => {
  const worker = new CapturingWorker();
  const unregister = registerWorker(worker);
  try {
    const pool = new AgentDriverPool();
    await pool.execute({
      prompt: "hello",
      workerName: "deep",
      cwd: process.cwd(),
      config: { type: "opencode", model: "model-x", args: ["--flag"] },
    });
    assert.equal(worker.lastInput?.config.model, "model-x");
    assert.deepEqual(worker.lastInput?.config.args, ["--flag"]);
    assert.equal(worker.lastInput?.prompt, "hello");
  } finally {
    unregister();
  }
});

test("AgentDriverPool rejects requests without execution identity", async () => {
  const pool = new AgentDriverPool();
  await assert.rejects(pool.execute({
    prompt: "hello",
    workerName: "opencode",
    config: { type: "opencode" },
  } as never), /requires workerName and cwd/);
});

test("AgentDriverPool pickWorker respects the Agent role's Worker pool", () => {
  const pool = new AgentDriverPool();
  const config = minimalConfig();
  config.workers = {
    w1: { type: "opencode" },
    w2: { type: "codex" },
    forbidden: { type: "pi" },
  };
  assert.equal(pool.pickWorker(config, ["w2"]), "w2");
});
