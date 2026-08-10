import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerConfig } from "../dist/utils/types.js";
import { opencodeProtocol } from "../dist/worker/backends/opencode.js";
import type { ProcessResult, WorkerCall } from "../dist/worker/types.js";

const config: WorkerConfig = {
  type: "opencode",
  model: "provider/model",
  taskTypes: ["execute"],
  maxRunning: 1,
  priority: 1,
  env: {},
};

function call(session?: WorkerCall["session"]): WorkerCall {
  return { config, prompt: "prompt", session };
}

const result = (stdout: string): ProcessResult => ({
  stdout, stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true,
});

test("OpenCode protocol resumes a captured session", () => {
  assert.equal(opencodeProtocol.canResume, true);
  assert.deepEqual(opencodeProtocol.build(call(), undefined).argv,
    ["opencode", "run", "--format", "json", "--model", "provider/model", "-"]);
  const session = { workerType: "opencode" as const, value: "ses_test" };
  assert.deepEqual(opencodeProtocol.build(call(session), session).argv,
    ["opencode", "run", "--format", "json", "--session", "ses_test", "--model", "provider/model", "-"]);
});

test("OpenCode protocol parses text and sessionID from JSON events", () => {
  const parsed = opencodeProtocol.parse(result([
    JSON.stringify({ type: "step_start", sessionID: "ses_test", part: {} }),
    JSON.stringify({ type: "text", sessionID: "ses_test", part: { text: "answer" } }),
  ].join("\n")));
  assert.equal(parsed.text, "answer");
  assert.deepEqual(parsed.session, { workerType: "opencode", value: "ses_test" });
});

test("OpenCode protocol leaves session undefined when no event exposes one", () => {
  const parsed = opencodeProtocol.parse(result(JSON.stringify({ type: "text", part: { text: "answer" } })));
  assert.equal(parsed.text, "answer");
  assert.equal(parsed.session, undefined);
});
