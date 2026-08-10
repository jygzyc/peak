import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("serve and local task Runtimes coexist; duplicate attach is rejected; stop cleans up", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-coexist-"));
  const peakHome = join(root, "peak-home");
  const taskDir = join(root, "task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    board: {
      name: "coexist",
      projects: [{ id: "", source: "Coexist inputs", goal: "coexist result" }],
    },
    workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
    scheduler: { intervalMs: 60_000 },
  }));
  try {
    const serve = await runCli(["serve", "--peak-home", peakHome, "--port", "0"]);
    assert.equal(serve.code, 0, serve.stderr);

    // A local task Runtime coexists with the serve process (M1: 1 serve + N tasks).
    const run = await runCli(["start", taskDir, "--peak-home", peakHome, "--port", "0", "--no-install-skills"]);
    assert.equal(run.code, 0, run.stderr);

    const status = spawnSync(process.execPath, ["dist/cli.js", "status", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /server: running/);
    assert.match(status.stdout, /task: coexist \(start, pid \d+\)/);
    const projectId = status.stdout.match(/project: ([0-9a-f-]{36})/)?.[1];
    assert.ok(projectId, status.stdout);

    // A second Runtime attaching the same active UUID is rejected (409 semantic).
    const duplicateDir = join(root, "duplicate");
    mkdirSync(duplicateDir, { recursive: true });
    writeFileSync(join(duplicateDir, "task.json"), JSON.stringify({
      board: {
        name: "duplicate",
        projects: [{ id: projectId, source: "Coexist inputs", goal: "coexist result" }],
      },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
      scheduler: { intervalMs: 60_000 },
    }));
    const duplicate = await runCli(["start", duplicateDir, "--peak-home", peakHome, "--port", "0", "--no-install-skills"]);
    assert.notEqual(duplicate.code, 0);
    const log = readFileSync(join(peakHome, "server.log"), "utf8");
    assert.match(log, /already actively registered/);

    const stopped = spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped task: \d+/);
    assert.match(stopped.stdout, /stopped server: \d+/);
    const after = spawnSync(process.execPath, ["dist/cli.js", "status", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.match(after.stdout, /server: stopped/);
    assert.match(after.stdout, /tasks: none/);
  } finally {
    spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    cleanup(root);
  }
});

test("peak start --graph-url attaches to an external serve and registers with graphUrl", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-graph-url-"));
  const peakHome = join(root, "peak-home");
  const taskDir = join(root, "task");
  try {
    const serve = await runCli(["serve", "--peak-home", peakHome, "--port", "0"]);
    assert.equal(serve.code, 0, serve.stderr);
    const serveUrl = webUrl(serve.stdout);
    const created = await fetch(`${serveUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "External inputs", target: "External inputs", goal: "external result" }),
    });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };

    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({
      board: { name: "external", projects: [{ id: project.id, source: "External inputs", goal: "external result" }] },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
      scheduler: { intervalMs: 60_000 },
    }));
    const run = await runCli([
      "start", taskDir,
      "--peak-home", peakHome,
      "--graph-url", serveUrl,
      "--projects-root", join(peakHome, "projects"),
      "--attach-only",
      "--no-install-skills",
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, new RegExp(serveUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const status = spawnSync(process.execPath, ["dist/cli.js", "status", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /server: running/);
    assert.match(status.stdout, /task: external \(start, pid \d+\)/);
    assert.match(status.stdout, new RegExp(serveUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const stopped = spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped task: \d+/);
    assert.match(stopped.stdout, /stopped server: \d+/);
  } finally {
    spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    cleanup(root);
  }
});

function webUrl(output: string): string {
  const match = output.match(/\[peak] web: (http:\/\/\S+)/);
  assert.ok(match, `missing Web URL in output: ${output}`);
  return match[1]!;
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
}

function cleanup(path: string): void {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    const removed = spawnSync("powershell.exe", ["-NoProfile", "-Command", "& { param([string]$target) Remove-Item -LiteralPath $target -Recurse -Force }", path], {
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  }
}
