import { test } from "node:test";
import { strict as assert } from "node:assert";
import { OpencodeCliBackend } from "../dist/worker/backends/opencode-cli.js";

const backend = new OpencodeCliBackend();

test("opencode-cli: extractResponseText parses NDJSON part.text format (opencode 1.17+)", () => {
  // Real opencode --format json output: text events with nested part.text
  const ndjson = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", part: { type: "text", text: '{"kind":"fact","data":{"description":"found X"}}' } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
  ].join("\n");

  const text = backend.extractResponseText(ndjson, "");
  assert.equal(text, '{"kind":"fact","data":{"description":"found X"}}');
});

test("opencode-cli: extractResponseText handles flat text events", () => {
  const ndjson = [
    JSON.stringify({ type: "text", text: "hello" }),
    JSON.stringify({ type: "text", text: "world" }),
  ].join("\n");

  const text = backend.extractResponseText(ndjson, "");
  assert.equal(text, "hello\nworld");
});

test("opencode-cli: extractResponseText returns plain text when no JSON events", () => {
  // Non-JSON stdout (plain assistant text with no event stream) is returned
  // verbatim so callers still get the content.
  const raw = "just plain text output, no JSON";
  const text = backend.extractResponseText(raw, "");
  assert.equal(text, raw);
});

test("opencode-cli: extractResponseText returns empty for step-only NDJSON (no text, no tool)", () => {
  // Model stopped early: only step_start + step_finish, no text event and no
  // tool_use. Must return "" (not raw NDJSON) so parseEnvelope reports a clear
  // "empty output" error instead of leaking {"type":"step_start",...} into it.
  const ndjson = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { output: 1 } } }),
  ].join("\n");

  const text = backend.extractResponseText(ndjson, "");
  assert.equal(text, "");
});

test("opencode-cli: extractResponseText falls back to tool_use output when no text event", () => {
  // Model emitted its JSON answer via a bash tool call (echo) instead of a
  // final text event. The answer lives in tool_use.part.state.output.
  const ndjson = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "completed", output: '{"kind":"fact","data":{"description":"x"}}\n' } } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
  ].join("\n");

  const text = backend.extractResponseText(ndjson, "");
  assert.equal(text, '{"kind":"fact","data":{"description":"x"}}');
});

test("opencode-cli: extractResponseText prefers text events over tool_use output", () => {
  // When both a text event and tool output exist, the text event wins.
  const ndjson = [
    JSON.stringify({ type: "tool_use", part: { state: { output: "tool noise" } } }),
    JSON.stringify({ type: "text", part: { type: "text", text: "final answer" } }),
  ].join("\n");

  const text = backend.extractResponseText(ndjson, "");
  assert.equal(text, "final answer");
});

test("opencode-cli: extractResponseText skips non-JSON lines", () => {
  const mixed = [
    "some diagnostic line",
    JSON.stringify({ type: "text", part: { type: "text", text: "real answer" } }),
    "another non-json line",
  ].join("\n");

  const text = backend.extractResponseText(mixed, "");
  assert.equal(text, "real answer");
});

test("opencode-cli: extractSession finds ses_ id in output", () => {
  const output = 'session created: ses_abc123def456';
  const sid = backend.extractSession(output, "");
  assert.equal(sid, "ses_abc123def456");
});

test("opencode-cli: buildArgv uses --format json and stdin for prompt", () => {
  const config = { kind: "agent" as const, backend: "opencode", model: "anthropic/claude-sonnet-4-5" };
  const built = backend.buildArgv(config, "test prompt");
  const argvStr = built.argv.join(" ");
  assert.ok(argvStr.includes("--format json"), "should use --format json");
  assert.ok(!argvStr.includes("--print"), "should NOT use --print");
  assert.ok(argvStr.includes("opencode run"), "should start with opencode run");
  assert.ok(built.input === "test prompt", "should pass prompt via stdin (input)");
});

test("opencode-cli: buildArgv adds --session for resume", () => {
  const config = { kind: "agent" as const, backend: "opencode" };
  const built = backend.buildArgv(config, "test prompt", { sessionId: "ses_resume123" });
  const argvStr = built.argv.join(" ");
  assert.ok(argvStr.includes("--session ses_resume123"), "should add --session for resume");
});
