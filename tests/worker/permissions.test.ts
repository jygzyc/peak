import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKER_PERMISSIONS,
  PathPermissionError,
  buildPermittedTools,
  checkBashCommand,
  guardedBashOperations,
  isWithinCwd,
  resolveWithinCwd,
  scrubBashEnv,
} from "../../dist/worker/permissions.js";
import type { WorkerPermissions } from "../../dist/worker/types.js";

function permissions(overrides: Partial<WorkerPermissions> = {}): WorkerPermissions {
  return { ...DEFAULT_WORKER_PERMISSIONS, bashAllow: [], bashDeny: [], ...overrides };
}

/** Collects every chunk streamed to onData into one string. */
function capture(): { onData: (data: Buffer) => void; output: () => string } {
  const chunks: Buffer[] = [];
  return {
    onData: (data: Buffer) => { chunks.push(data); },
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

test("resolveWithinCwd accepts in-tree paths and rejects escapes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "peak-perms-"));
  try {
    assert.equal(resolveWithinCwd(cwd, "sub/dir"), join(cwd, "sub", "dir"));
    assert.equal(resolveWithinCwd(cwd, cwd), cwd, "the working directory itself is allowed");
    assert.equal(resolveWithinCwd(cwd, "."), cwd);
    assert.ok(isWithinCwd(cwd, join(cwd, "sub")));
    assert.ok(isWithinCwd(cwd, cwd));
    assert.ok(!isWithinCwd(cwd, join(cwd, "..", "outside")));
    assert.throws(() => resolveWithinCwd(cwd, "../escape"), PathPermissionError);
    assert.throws(() => resolveWithinCwd(cwd, join(cwd, "..", "escape")), PathPermissionError, "absolute path outside the boundary");
    assert.throws(() => resolveWithinCwd(cwd, tmpdir()), PathPermissionError);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("checkBashCommand enforces built-in and custom denies, then the allow-list", () => {
  const open = permissions();
  assert.match(checkBashCommand("rm -rf /", open)!, /denied pattern/);
  assert.match(checkBashCommand("sudo shutdown -h now", open)!, /denied pattern/);
  assert.equal(checkBashCommand("echo hello", open), undefined, "ordinary commands run");

  const custom = permissions({ bashDeny: ["curl", "wget"] });
  assert.match(checkBashCommand("curl https://example.com", custom)!, /denied pattern: curl/);
  assert.equal(checkBashCommand("echo hello", custom), undefined);

  const allow = permissions({ bashAllow: ["git", "node"] });
  assert.match(checkBashCommand("npm install", allow)!, /does not match any allowed prefix/);
  assert.equal(checkBashCommand("git status", allow), undefined);
  assert.equal(checkBashCommand("  node --version", allow), undefined, "leading whitespace is trimmed before prefix matching");

  // Deny wins over allow.
  const both = permissions({ bashAllow: ["rm"], bashDeny: [] });
  assert.match(checkBashCommand("rm -rf /", both)!, /denied pattern/);
});

test("scrubBashEnv drops credentials, keeps PATH, and pins temp dirs to cwd", () => {
  const cwd = join(tmpdir(), "peak-scrub-cwd");
  const env = scrubBashEnv(cwd, {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    HOME: "/home/test",
    PI_MODEL: "pi/model",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.PI_MODEL, "pi/model", "PI_* variables pass through");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.TMPDIR, cwd);
  assert.equal(env.TMP, cwd);
  assert.equal(env.TEMP, cwd);
});

test("guardedBashOperations denies commands with exit 126 and a reason", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "peak-perms-"));
  try {
    const operations = guardedBashOperations(cwd, permissions());
    const sink = capture();
    const result = await operations.exec("shutdown /s /t 0", cwd, { onData: sink.onData });
    assert.equal(result.exitCode, 126);
    assert.match(sink.output(), /peak permission: bash denied: command matches denied pattern: shutdown/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("guardedBashOperations runs allowed commands and streams their output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "peak-perms-"));
  try {
    const operations = guardedBashOperations(cwd, permissions());
    const sink = capture();
    const script = "process.stdout.write('ok')";
    const result = await operations.exec(`"${process.execPath}" -e "${script}"`, cwd, { onData: sink.onData, timeout: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.match(sink.output(), /ok/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("guardedBashOperations truncates streamed output at the byte cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "peak-perms-"));
  try {
    const operations = guardedBashOperations(cwd, permissions({ bashMaxOutputBytes: 16 }));
    const sink = capture();
    const script = `process.stdout.write('${"x".repeat(4096)}')`;
    const result = await operations.exec(`"${process.execPath}" -e "${script}"`, cwd, { onData: sink.onData, timeout: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.match(sink.output(), /\[peak] bash output truncated at 16 bytes/);
    assert.ok(sink.output().length < 4096, "the full stream is not forwarded past the cap");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("buildPermittedTools reflects the write and bash switches", () => {
  const cwd = mkdtempSync(join(tmpdir(), "peak-perms-"));
  try {
    const full = buildPermittedTools(cwd, permissions());
    assert.deepEqual(full.toolNames, ["read", "grep", "find", "ls", "write", "edit", "bash"]);
    assert.deepEqual(full.tools.map((tool) => tool.name), full.toolNames, "toolNames aligns with tools");

    const readOnly = buildPermittedTools(cwd, permissions({ write: false }));
    assert.deepEqual(readOnly.toolNames, ["read", "grep", "find", "ls", "bash"]);

    const noBash = buildPermittedTools(cwd, permissions({ bash: false }));
    assert.deepEqual(noBash.toolNames, ["read", "grep", "find", "ls", "write", "edit"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
