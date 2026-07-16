import { test } from "node:test";
import { strict as assert } from "node:assert";
import { CodexBackend } from "../dist/worker/backends/codex.js";

const backend = new CodexBackend();

test("codex: buildArgv passes prompt via stdin (-), not as argv arg", () => {
  const config = { kind: "agent" as const, backend: "codex" };
  const built = backend.buildArgv(config, "a long\nprompt with \"quotes\" and {json}");
  const argvStr = built.argv.join(" ");
  // The prompt must NOT appear in argv (it goes through stdin to avoid
  // Windows cmd.exe arg-length/quoting issues).
  assert.ok(!argvStr.includes("a long"), "prompt text must not be in argv");
  assert.ok(argvStr.includes("-"), "should use '-' to read prompt from stdin");
  assert.equal(built.input, "a long\nprompt with \"quotes\" and {json}", "prompt passed via input (stdin)");
});

test("codex: buildArgv uses exec with sandbox bypass", () => {
  const config = { kind: "agent" as const, backend: "codex" };
  const built = backend.buildArgv(config, "x");
  const argvStr = built.argv.join(" ");
  assert.ok(argvStr.startsWith("codex exec"), "should start with codex exec");
  assert.ok(argvStr.includes("--dangerously-bypass-approvals-and-sandbox"), "should bypass sandbox");
});

test("codex: buildArgv adds --model from config", () => {
  const config = { kind: "agent" as const, backend: "codex", model: "gpt-5.5" };
  const built = backend.buildArgv(config, "x");
  assert.ok(built.argv.includes("--model"), "should include --model flag");
  assert.ok(built.argv.includes("gpt-5.5"), "should include the model name");
});

test("codex: buildArgv uses the exec resume subcommand for session continuation", () => {
  const config = { kind: "agent" as const, backend: "codex" };
  const built = backend.buildArgv(config, "x", { sessionId: "abc-1234-5678" });
  const argvStr = built.argv.join(" ");
  assert.ok(argvStr.includes("exec resume"), "should select the resume subcommand");
  assert.ok(argvStr.includes("abc-1234-5678 -"), "session id must precede the stdin prompt marker");
  assert.ok(!built.argv.includes("--resume"), "current Codex CLI has no --resume option");
});

test("codex: buildArgv wires OPENAI_API_KEY env when key present", () => {
  const config = { kind: "agent" as const, backend: "codex", apiKeyEnv: "OPENAI_API_KEY" };
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-key";
  try {
    const built = backend.buildArgv(config, "x");
    assert.equal(built.env?.OPENAI_API_KEY, "sk-test-key", "should pass key through env");
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("codex: ignores non-JSON session text", () => {
  const output = "session: 12345678-1234-1234-1234-123456789abc created";
  const sid = backend.extractSession(output, "");
  assert.equal(sid, undefined);
});

test("codex: extracts thread id and final assistant text from --json events", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "12345678-1234-1234-1234-123456789abc" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
  ].join("\n");
  assert.equal(backend.extractSession(output, ""), "12345678-1234-1234-1234-123456789abc");
  assert.equal(backend.extractResponseText(output, ""), "final answer");
});
