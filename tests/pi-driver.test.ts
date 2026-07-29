import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedTaskConfig } from "../dist/config/types.js";
import { ProcessRunner } from "../dist/worker/process-runner.js";
import type { ProcessResult, ProcessSpec } from "../dist/worker/types.js";
import { WorkerResources, WorkerRuntime } from "../dist/worker/worker-runtime.js";

class RejectingProcessRunner extends ProcessRunner {
  override run(_spec: ProcessSpec, _cwd: string, _timeoutMs: number, _signal?: AbortSignal): Promise<ProcessResult> {
    throw new Error("PiDriver must not use ProcessRunner");
  }
}

test("WorkerRuntime drives the registered PiDriver through the Agent SDK path", async () => {
  const config = configuration();
  const resources = new WorkerResources(new RejectingProcessRunner());
  try {
    const runtime = new WorkerRuntime(config, resources);
    const result = await runtime.execute("pi", "execute", "prompt", 1_000, process.cwd());
    assert.equal(result.started, false);
    assert.match(result.stderr, /not supported by the Pi Agent SDK/);
  } finally {
    resources.dispose();
  }
});

function configuration(): ResolvedTaskConfig {
  return {
    configPath: "/task.json",
    taskDir: "/",
    board: {
      workspace: process.cwd(),
      skills: [],
      projects: [{ name: "Main", goal: "done" }],
    },
    workers: {
      pi: {
        type: "pi",
        taskTypes: ["plan", "supervise", "execute"],
        maxRunning: 1,
        priority: 1,
        args: ["unsupported"],
      },
    },
    scheduler: {
      maxConcurrent: 1,
      maxRunningProjects: 1,
      maxProjectConcurrent: 1,
      refillPerTick: 1,
      intervalMs: 1_000,
    },
    phase: {
      plan: { maxIntents: 1 },
      supervise: { intervalMs: 1_000 },
      execute: { maxArtifactBytes: 1_024 },
    },
  };
}
