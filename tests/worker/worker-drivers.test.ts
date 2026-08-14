import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCodeProtocol } from "../../dist/worker/backends/claude-code.js";
import { codexProtocol } from "../../dist/worker/backends/codex.js";
import type { ProcessResult, WorkerCall } from "../../dist/worker/types.js";

function call(type: "codex" | "claude-code", session?: { workerType: "codex" | "claude-code"; value: string }): WorkerCall {
  return {
    config: { type, taskTypes: ["execute"], maxRunning: 1, priority: 1, env: {} },
    prompt: "prompt", session,
  };
}

test("Claude Code protocol seeds a resumable session before Execute can fail", () => {
  const seeded = claudeCodeProtocol.prepareSession!(call("claude-code"));
  assert.equal(seeded!.workerType, "claude-code");
  assert.match(seeded!.value ?? "", /^[0-9a-f-]{36}$/i);

  // Fresh-session argv uses --session-id.
  const fresh = claudeCodeProtocol.build(call("claude-code"), seeded);
  assert.deepEqual(fresh.argv.slice(0, 3), ["claude", "--session-id", seeded!.value]);

  // Resume argv uses -r when a session is supplied on the call.
  const resume = claudeCodeProtocol.build(call("claude-code", seeded), seeded);
  assert.deepEqual(resume.argv.slice(0, 3), ["claude", "-r", seeded!.value]);

  const parsed = claudeCodeProtocol.parse({
    stdout: '{"result":"done","session_id":"' + seeded!.value + '"}',
    stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true,
  } satisfies ProcessResult);
  assert.equal(parsed.text, "done");
  assert.equal(parsed.session!.value, seeded!.value);
});

test("Codex protocol recovers a session id from failed command diagnostics", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const parsed = codexProtocol.parse({
    stdout: "", stderr: `Session ID: ${id}\nprovider request failed`,
    returncode: 1, timedOut: false, cancelled: false, started: true,
  } satisfies ProcessResult);
  assert.deepEqual(parsed.session, { workerType: "codex", value: id });
});
