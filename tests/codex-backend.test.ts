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

test("codex: buildArgv adds --resume for session continuation", () => {
  const config = { kind: "agent" as const, backend: "codex" };
  const built = backend.buildArgv(config, "x", { sessionId: "abc-1234-5678" });
  const argvStr = built.argv.join(" ");
  assert.ok(argvStr.includes("--resume abc-1234-5678"), "should add --resume for session");
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

test("codex: extractSession finds session id in output", () => {
  const output = "session: 12345678-1234-1234-1234-123456789abc created";
  const sid = backend.extractSession(output, "");
  assert.equal(sid, "12345678-1234-1234-1234-123456789abc");
});
