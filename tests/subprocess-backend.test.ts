import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessBackend } from "../dist/worker/backends/subprocess.js";
import { ClaudeBackend } from "../dist/worker/backends/claude.js";
import type { WorkerConfig } from "../dist/agent/types.js";

class StdinBatchBackend extends SubprocessBackend {
  readonly id = "stdin-batch-test";

  buildArgv(config: WorkerConfig, prompt: string) {
    return {
      argv: [config.command!, "a&b"],
      input: prompt,
    };
  }
}

class TreeBatchBackend extends SubprocessBackend {
  readonly id = "tree-batch-test";

  buildArgv(config: WorkerConfig, prompt: string) {
    return { argv: [config.command!], input: prompt };
  }
}

test("ClaudeBackend: uses the first-version JSON result contract", () => {
  const backend = new ClaudeBackend();
  const built = backend.buildArgv({ kind: "agent", backend: "claude-code" }, "prompt");
  assert.deepEqual(built.argv.slice(0, 6), [
    "claude", "--dangerously-skip-permissions", "-p", "--output-format", "json",
  ]);
  const output = JSON.stringify({ type: "result", session_id: "session-1", result: "answer" });
  assert.equal(backend.extractSession(output, ""), "session-1");
  assert.equal(backend.extractResponseText(output, ""), "answer");
});

test("ClaudeBackend: rejects non-JSON output", () => {
  const backend = new ClaudeBackend();
  assert.equal(backend.extractSession("session: session-1", ""), undefined);
  assert.equal(backend.extractResponseText("plain answer", ""), "");
});

test("SubprocessBackend: Windows .cmd shim is isolated and prompt stays on stdin", {
  skip: process.platform !== "win32",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "peak shim "));
  const shim = join(dir, "worker.cmd");
  writeFileSync(shim, [
    "@echo off",
    "set /p PEAK_INPUT=",
    "echo arg=%~1",
    "echo input=%PEAK_INPUT%",
  ].join("\r\n"));

  const result = await new StdinBatchBackend().invoke({
    prompt: "prompt-value",
    config: { kind: "agent", command: shim, timeoutMs: 5_000 },
    cwd: dir,
  });

  assert.equal(result.returncode, 0, result.stderr);
  assert.match(result.text, /arg=a&b/);
  assert.match(result.text, /input=prompt-value/);
});

test("SubprocessBackend: AbortSignal terminates a Windows shim process tree", {
  skip: process.platform !== "win32",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "peak tree "));
  const pidFile = join(dir, "child.pid");
  writeFileSync(join(dir, "child.mjs"), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.argv[2], String(process.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const shim = join(dir, "worker.cmd");
  writeFileSync(shim, [
    "@echo off",
    "node \"%~dp0child.mjs\" \"%~dp0child.pid\"",
  ].join("\r\n"));

  const controller = new AbortController();
  const pending = new TreeBatchBackend().invoke({
    prompt: "stdin-only-prompt",
    config: { kind: "agent", command: shim, timeoutMs: 10_000 },
    cwd: dir,
    signal: controller.signal,
  });
  await waitUntil(() => existsSync(pidFile), 2_000);
  const childPid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(isAlive(childPid), true);

  controller.abort(new Error("test cancellation"));
  const result = await pending;
  await waitUntil(() => !isAlive(childPid), 2_000);

  assert.equal(result.aborted, true);
  assert.equal(isAlive(childPid), false, "descendant must not survive the cancelled shim");
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for subprocess state");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
