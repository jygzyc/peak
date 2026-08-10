import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("peak start starts in the background, persists Projects, and exposes status", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-board-"));
  const peakHome = join(root, "peak-home");
  const taskDir = join(root, "task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    board: {
      name: "board",
      projects: [
        { id: "", source: "Research inputs", goal: "research result" },
        { id: "", source: "Delivery inputs", goal: "delivery result" },
      ],
    },
    workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
    scheduler: { intervalMs: 60_000 },
  }));
  try {
    const first = await runCli(["start", taskDir, "--peak-home", peakHome, "--port", "0", "--no-install-skills"]);
    assert.equal(first.code, 0, first.stderr);
    const baseUrl = webUrl(first.stdout);
    const projects = await fetch(`${baseUrl}/api/projects`).then(async (response) => response.json()) as Array<{ id: string; title: string }>;
    assert.deepEqual(projects.map((project) => project.title).sort(), ["Delivery inputs", "Research inputs"]);
    const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(taskDir, "task.json"), "utf8"))) as {
      board: { projects: Array<{ id: string }> };
    };
    assert.deepEqual(persisted.board.projects.map((project) => project.id).sort(), projects.map((project) => project.id).sort());

    const status = spawnSync(process.execPath, ["dist/cli.js", "status", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /task: board \(start, pid \d+\)/);
    assert.match(status.stdout, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const stopped = stop(peakHome);
    assert.match(stopped.stdout, /stopped task: \d+/);

    const second = await runCli(["start", taskDir, "--peak-home", peakHome, "--port", "0", "--no-install-skills"]);
    assert.equal(second.code, 0, second.stderr);
    const reused = await fetch(`${webUrl(second.stdout)}/api/projects`).then(async (response) => response.json()) as Array<{ id: string }>;
    assert.deepEqual(reused.map((project) => project.id).sort(), projects.map((project) => project.id).sort());
  } finally {
    stop(peakHome, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    cleanup(root);
  }
});

test("peak serve starts in the background until peak stop", async () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-serve-"));
  try {
    const started = await runCli(["serve", "--peak-home", peakHome, "--port", "0"]);
    assert.equal(started.code, 0, started.stderr);
    const response = await fetch(webUrl(started.stdout));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Peak Graph/);
    const stopped = stop(peakHome);
    assert.match(stopped.stdout, /stopped server/);
    const status = spawnSync(process.execPath, ["dist/cli.js", "status", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.match(status.stdout, /server: stopped/);
  } finally {
    stop(peakHome, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    cleanup(peakHome);
  }
});

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

function webUrl(output: string): string {
  const match = output.match(/\[peak] web: (http:\/\/\S+)/);
  assert.ok(match, `missing Web URL in output: ${output}`);
  return match[1]!;
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

function stop(peakHome: string, required = true): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, ["dist/cli.js", "stop", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
  if (required) assert.equal(result.status, 0, result.stderr);
  return result;
}
