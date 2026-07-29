import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("peak run creates, persists, and reuses every configured Board Project", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-board-"));
  const peakHome = join(root, "peak-home");
  const taskDir = join(root, "task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    board: {
      name: "board",
      projects: [
        { id: "", name: "Research", goal: "research result" },
        { id: "", name: "Delivery", goal: "delivery result" },
      ],
    },
    workers: [
      { type: "pi", taskTypes: ["plan", "supervise", "execute"], args: ["unsupported"] },
    ],
    scheduler: { intervalMs: 60_000 },
  }));
  const child = spawn(process.execPath, ["dist/cli.js", "run", taskDir, "--peak-home", peakHome, "--port", "0", "--no-install-skills"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const baseUrl = await outputUrl(child.stdout);
    const projects = await fetch(`${baseUrl}/api/projects`).then(async (response) => response.json()) as Array<{ id: string; title: string }>;
    assert.deepEqual(projects.map((project) => project.title).sort(), ["Delivery", "Research"]);
    const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(taskDir, "task.json"), "utf8"))) as {
      board: { projects: Array<{ id: string }> };
    };
    assert.deepEqual(persisted.board.projects.map((project) => project.id).sort(), projects.map((project) => project.id).sort());
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const code = await exited;
    assert.ok(code === 0 || child.signalCode === "SIGTERM", stderr);

    const reused = spawn(process.execPath, ["dist/cli.js", "run", taskDir, "--peak-home", peakHome, "--port", "0", "--no-install-skills"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let reusedStderr = "";
    reused.stderr.setEncoding("utf8");
    reused.stderr.on("data", (chunk: string) => { reusedStderr += chunk; });
    try {
      const reusedUrl = await outputUrl(reused.stdout);
      const reusedProjects = await fetch(`${reusedUrl}/api/projects`).then(async (response) => response.json()) as Array<{ id: string }>;
      assert.deepEqual(reusedProjects.map((project) => project.id).sort(), projects.map((project) => project.id).sort());
      const reusedExited = new Promise<number | null>((resolve) => reused.once("exit", resolve));
      reused.kill("SIGTERM");
      const reusedCode = await reusedExited;
      assert.ok(reusedCode === 0 || reused.signalCode === "SIGTERM", reusedStderr);
    } finally {
      if (reused.exitCode === null && reused.signalCode === null) {
        const reusedExited = new Promise((resolve) => reused.once("exit", resolve));
        reused.kill("SIGKILL");
        await reusedExited;
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("peak serve keeps the Web UI available until SIGTERM", async () => {
  const peakHome = mkdtempSync(join(tmpdir(), "peak-serve-"));
  const child = spawn(process.execPath, ["dist/cli.js", "serve", "--peak-home", peakHome, "--port", "0"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const baseUrl = await outputUrl(child.stdout);
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Peak Graph/);
    assert.equal(child.exitCode, null);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const code = await exited;
    assert.ok(code === 0 || child.signalCode === "SIGTERM", stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(peakHome, { recursive: true, force: true });
  }
});

function outputUrl(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for server URL: ${output}`)), 5_000);
    stream.on("data", (chunk: string) => {
      output += chunk;
      const match = output.match(/\[peak] web: (http:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]!);
    });
  });
}
