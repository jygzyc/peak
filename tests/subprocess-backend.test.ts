import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseWorker } from "../dist/worker/backends/subprocess.js";
import { ClaudeCodeWorker } from "../dist/worker/backends/claude.js";
import type { WorkerConfig } from "../dist/agent/types.js";

class StdinBatchWorker extends BaseWorker {
  readonly type = "stdin-batch-test";
  private readonly command: string;

  constructor(command: string) {
    super();
    this.command = command;
  }

  buildArgv(config: WorkerConfig, prompt: string) {
    return {
      argv: [this.command, "a&b"],
      input: prompt,
    };
  }
}

class TreeBatchWorker extends BaseWorker {
  readonly type = "tree-batch-test";
  private readonly command: string;

  constructor(command: string) {
    super();
    this.command = command;
  }

  buildArgv(config: WorkerConfig, prompt: string) {
    return { argv: [this.command], input: prompt };
  }
}

test("ClaudeCodeWorker: uses the first-version JSON result contract", () => {
  const worker = new ClaudeCodeWorker();
  const built = worker.buildArgv({ type: "claude-code", model: "sonnet" }, "prompt");
  assert.deepEqual(built.argv.slice(0, 5), [
    "claude", "--dangerously-skip-permissions", "-p", "--output-format", "json",
  ]);
  assert.deepEqual(built.argv.slice(5, 7), ["--model", "sonnet"]);
  const output = JSON.stringify({ type: "result", session_id: "session-1", result: "answer" });
  assert.equal(worker.extractResponseText(output), "answer");
});

test("ClaudeCodeWorker: rejects non-JSON output", () => {
  const worker = new ClaudeCodeWorker();
  assert.equal(worker.extractResponseText("plain answer"), "");
});

test("BaseWorker: Windows .cmd shim is isolated and prompt stays on stdin", {
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

  const result = await new StdinBatchWorker(shim).execute({
    prompt: "prompt-value",
    config: { type: "opencode", timeoutMs: 5_000 },
    workerName: "test",
    cwd: dir,
  });

  assert.equal(result.returncode, 0, result.stderr);
  assert.match(result.text, /arg=a&b/);
  assert.match(result.text, /input=prompt-value/);
});

test("BaseWorker: AbortSignal terminates a Windows shim process tree", {
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
  const pending = new TreeBatchWorker(shim).execute({
    prompt: "stdin-only-prompt",
    config: { type: "opencode", timeoutMs: 10_000 },
    workerName: "test",
    cwd: dir,
    signal: controller.signal,
  });
  await waitUntil(() => existsSync(pidFile), 2_000);
  const childPid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(isAlive(childPid), true);

  controller.abort(new Error("test cancellation"));
  const result = await pending;
  await waitUntil(() => !isAlive(childPid), 2_000);

  assert.equal(result.stderr, "worker cancelled");
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
