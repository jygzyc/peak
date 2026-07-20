import { test } from "node:test";
import { strict as assert } from "node:assert";
import { CodexWorker } from "../dist/worker/backends/codex.js";

const worker = new CodexWorker();

test("codex: buildArgv passes prompt via stdin (-), not as argv arg", () => {
  const config = { type: "codex" as const };
  const built = worker.buildArgv(config, "a long\nprompt with \"quotes\" and {json}");
  const argvStr = built.argv.join(" ");
  // The prompt must NOT appear in argv (it goes through stdin to avoid
  // Windows cmd.exe arg-length/quoting issues).
  assert.ok(!argvStr.includes("a long"), "prompt text must not be in argv");
  assert.ok(argvStr.includes("-"), "should use '-' to read prompt from stdin");
  assert.equal(built.input, "a long\nprompt with \"quotes\" and {json}", "prompt passed via input (stdin)");
});

test("codex: buildArgv uses exec with sandbox bypass", () => {
  const config = { type: "codex" as const };
  const built = worker.buildArgv(config, "x");
  const argvStr = built.argv.join(" ");
  assert.ok(argvStr.startsWith("codex exec"), "should start with codex exec");
  assert.ok(argvStr.includes("--dangerously-bypass-approvals-and-sandbox"), "should bypass sandbox");
});

test("codex: buildArgv adds --model from config", () => {
  const config = { type: "codex" as const, model: "gpt-5.5" };
  const built = worker.buildArgv(config, "x");
  assert.ok(built.argv.includes("--model"), "should include --model flag");
  assert.ok(built.argv.includes("gpt-5.5"), "should include the model name");
});

test("codex: Worker does not inject provider or API credentials", () => {
  const built = worker.buildArgv({ type: "codex" }, "x");
  assert.equal(built.env, undefined);
  assert.ok(!built.argv.some((arg) => arg.includes("model_provider")));
});

test("codex: extracts final assistant text from --json events", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "12345678-1234-1234-1234-123456789abc" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
  ].join("\n");
  assert.equal(worker.extractResponseText(output), "final answer");
});
