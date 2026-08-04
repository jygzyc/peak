import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResolvedTaskConfig } from "../dist/config/types.js";
import { AgentRuntime } from "../dist/runtime/agent-runtime.js";

function configuration(root: string): ResolvedTaskConfig {
  return {
    configPath: join(root, "task.json"), taskDir: root,
    board: { skills: [], projects: [{ source: "start", goal: "done" }] },
    // claude-code is not installed here, so any scheduler dispatch fails fast
    // (spawn ENOENT -> phase_failed) without invoking a real CLI.
    workers: {
      planner: { type: "claude-code", taskTypes: ["plan", "supervise"], maxRunning: 1, priority: 1, env: {} },
      executor: { type: "claude-code", taskTypes: ["execute"], maxRunning: 1, priority: 1, env: {} },
    },
    scheduler: { maxRunningProjects: 1, intervalMs: 3_000 },
    phase: { plan: {}, supervise: { intervalMs: 60_000 }, execute: { maxArtifactBytes: 1024, customProfiles: [] } },
  };
}

test("AgentRuntime.logCrash records process_crash in every Project main.log", async () => {
  const root = mkdtempSync(join(tmpdir(), "peak-runtime-crash-"));
  const home = join(root, "home");
  mkdirSync(root, { recursive: true });
  // persistProjectId rewrites task.json, so the config file must exist first.
  writeFileSync(join(root, "task.json"), `${JSON.stringify({
    board: { name: "test", skills: [], projects: [{ source: "start", goal: "done" }] },
    workers: [
      { type: "claude-code", taskTypes: ["plan", "supervise"], maxRunning: 1, priority: 1 },
      { type: "claude-code", taskTypes: ["execute"], maxRunning: 1, priority: 1 },
    ],
    scheduler: { maxRunningProjects: 1, intervalMs: 3_000 },
    phase: { supervise: { intervalMs: 60_000 } },
  }, null, 2)}\n`);
  const runtime = new AgentRuntime(configuration(root), { peakHome: home, installSkills: false });
  try {
    const projects = await runtime.start();
    assert.ok(projects.length >= 1, "at least one Project registered");
    runtime.logCrash("uncaughtException", new Error("boom crash"));
    for (const project of projects) {
      const log = readFileSync(join(home, "projects", project.id, "logs", "main.log"), "utf8");
      assert.match(log, /"type":"process_crash"/);
      assert.match(log, /"kind":"uncaughtException"/);
      assert.match(log, /boom crash/);
    }
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
