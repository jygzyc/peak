import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeDriver } from "../dist/worker/backends/claude-code.js";
import { CodexDriver } from "../dist/worker/backends/codex.js";
import { ProcessRunner } from "../dist/worker/process-runner.js";
import type { ProcessResult, ProcessSpec, WorkerRequest } from "../dist/worker/types.js";

class FakeProcessRunner extends ProcessRunner {
  readonly specs: ProcessSpec[] = [];
  private readonly results: ProcessResult[];
  constructor(results: ProcessResult[]) {
    super();
    this.results = results;
  }
  override run(spec: ProcessSpec, _cwd: string, _timeoutMs: number, _signal?: AbortSignal): Promise<ProcessResult> {
    this.specs.push(spec);
    return Promise.resolve(this.results.shift()!);
  }
}

const failed: ProcessResult = {
  stdout: "",
  stderr: "provider request failed",
  returncode: 1,
  timedOut: false,
  cancelled: false,
  started: true,
};

function request(type: "codex" | "claude-code"): WorkerRequest {
  return {
    workerName: type,
    config: { type, taskTypes: ["execute"], maxRunning: 1, priority: 1, args: [] },
    taskType: "execute",
    prompt: "prompt",
    cwd: process.cwd(),
    timeoutMs: 1_000,
  };
}

test("Claude Code seeds a resumable session before Execute can fail", async () => {
  const runner = new FakeProcessRunner([
    failed,
    { ...failed, stdout: '{"result":"done"}', stderr: "", returncode: 0 },
  ]);
  const driver = new ClaudeCodeDriver(runner);
  const first = await driver.execute(request("claude-code"));

  assert.equal(first.session?.workerType, "claude-code");
  assert.match(first.session?.value ?? "", /^[0-9a-f-]{36}$/i);
  assert.deepEqual(runner.specs[0]!.argv.slice(0, 3), ["claude", "--session-id", first.session!.value]);

  await driver.execute({ ...request("claude-code"), session: first.session });
  assert.deepEqual(runner.specs[1]!.argv.slice(0, 3), ["claude", "-r", first.session!.value]);
});

test("Codex recovers a session id from failed command diagnostics", async () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const runner = new FakeProcessRunner([{ ...failed, stderr: `Session ID: ${id}\nprovider request failed` }]);
  const result = await new CodexDriver(runner).execute(request("codex"));

  assert.deepEqual(result.session, { workerType: "codex", value: id });
});
