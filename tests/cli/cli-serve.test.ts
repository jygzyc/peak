import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, stopServer, webUrl } from "../helpers/cli.ts";
import { removeTree } from "../helpers/tmp.ts";

test("peak serve and background Dispatch stay separate while persisting Projects", async () => {
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
    const serve = await runCli(["serve", "--peak-home", peakHome, "--port", "0"]);
    assert.equal(serve.code, 0, serve.stderr);
    const baseUrl = webUrl(serve.stdout);
    const first = await runCli([
      "start", taskDir, "--peak-home", peakHome, "--graph-url", baseUrl,
      "--projects-root", join(peakHome, "projects"), "--no-install-skills",
    ]);
    assert.equal(first.code, 0, first.stderr);
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
    const stopped = spawnSync(process.execPath, ["dist/cli.js", "stop", "board", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped task: board/);

    const second = await runCli([
      "start", taskDir, "--peak-home", peakHome, "--graph-url", baseUrl,
      "--projects-root", join(peakHome, "projects"), "--no-install-skills",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const reused = await fetch(`${baseUrl}/api/projects`).then(async (response) => response.json()) as Array<{ id: string }>;
    assert.deepEqual(reused.map((project) => project.id).sort(), projects.map((project) => project.id).sort());
  } finally {
    stopServer(peakHome, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    removeTree(root);
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
    const stopped = stopServer(peakHome);
    assert.match(stopped.stdout, /stopped server/);
    const status = spawnSync(process.execPath, ["dist/cli.js", "status", "--peak-home", peakHome], { cwd: process.cwd(), encoding: "utf8" });
    assert.match(status.stdout, /server: stopped/);
  } finally {
    stopServer(peakHome, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    removeTree(peakHome);
  }
});
