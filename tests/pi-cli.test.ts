import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerConfig } from "../dist/config/types.js";
import { buildPiArgv, piProtocol } from "../dist/worker/backends/pi.js";
import type { ProcessResult, WorkerCall } from "../dist/worker/types.js";

const OK: ProcessResult = {
  stdout: "", stderr: "", returncode: 0, timedOut: false, cancelled: false, started: true,
};
// Fake target so argv construction is testable without Pi installed.
const TARGET: [string, string[]] = ["/node", ["/pi/cli.js"]];

function piWorker(model?: string): WorkerConfig {
  return { type: "pi", model, taskTypes: ["execute"], maxRunning: 1, priority: 1, env: {} };
}

function call(config: WorkerConfig, tmpDir = "/sessions", session?: { workerType: "pi"; value: string }): WorkerCall {
  return { workerName: "pi", config, taskType: "execute", prompt: "prompt", cwd: process.cwd(), tmpDir, session };
}

function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

test("pi protocol builds a CLI argv with JSON mode and the prompt on stdin", () => {
  const spec = buildPiArgv(call(piWorker("deepseek/v4")), undefined, TARGET);
  assert.equal(spec.input, "prompt");
  assert.deepEqual(spec.argv.slice(0, 2), ["/node", "/pi/cli.js"]);
  const flags = spec.argv.slice(2);
  assert.deepEqual(flags.slice(0, 4), ["--mode", "json", "--session-dir", "/sessions"]);
  assert.equal(flags[flags.indexOf("--model") + 1], "deepseek/v4");
  assert.equal(flags[flags.length - 1], "-p", "prompt read from stdin via -p");
});

test("pi protocol omits --model when no model is configured", () => {
  const flags = buildPiArgv(call(piWorker()), undefined, TARGET).argv.slice(2);
  assert.equal(flags.includes("--model"), false);
});

test("pi protocol appends --session when resuming a captured session", () => {
  const flags = buildPiArgv(call(piWorker()), { workerType: "pi", value: "abc-123" }, TARGET).argv.slice(2);
  assert.deepEqual(flags.slice(4, 6), ["--session", "abc-123"]);
});

test("pi protocol extracts the session id from the session header event", () => {
  const stdout = jsonl([
    { type: "session", version: 3, id: "s-1", timestamp: "t", cwd: "/" },
    { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
  ]);
  const parsed = piProtocol.parse({ ...OK, stdout });
  assert.deepEqual(parsed.session, { workerType: "pi", value: "s-1" });
  assert.equal(parsed.text, "done");
});

test("pi protocol extracts assistant text from the last agent_end messages", () => {
  const stdout = jsonl([
    { type: "session", id: "s-2" },
    { type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "ignored" }] }] },
    { type: "agent_end", messages: [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "x" }, { type: "text", text: "final answer" }] },
    ] },
  ]);
  assert.equal(piProtocol.parse({ ...OK, stdout }).text, "final answer");
});

test("pi protocol falls back to raw stdout when no agent_end event is present", () => {
  const stdout = jsonl([{ type: "session", id: "s-3" }]);
  assert.equal(piProtocol.parse({ ...OK, stdout }).text, stdout.trim());
});
