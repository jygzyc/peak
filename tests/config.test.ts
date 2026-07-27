import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTaskConfig } from "../dist/config/task-config.js";
import { initializeTaskSkills } from "../dist/config/task-skill-installer.js";

test("config is strict and initializes task skills", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-config-"));
  try {
    mkdirSync(join(root, "skills", "review"), { recursive: true });
    writeFileSync(join(root, "skills", "review", "SKILL.md"), "# Review\n");
    writeFileSync(join(root, "task.json"), JSON.stringify({
      task: { target: "start", goal: "done", workspace: ".", skills: ["review"] },
      workers: { main: { type: "pi", taskTypes: ["plan", "supervise", "execute"] } },
    }));
    const config = loadTaskConfig(join(root, "task.json"));
    assert.equal(config.task.workspace, root);
    assert.equal(config.tasks.supervise.intervalMs, 60_000);
    const agents = join(root, "agents-skills");
    initializeTaskSkills(config, { agentsDir: agents, claudeDir: join(root, "claude-skills") });
    initializeTaskSkills(config, { agentsDir: agents, claudeDir: join(root, "claude-skills") });
    assert.ok(existsSync(join(agents, "review", "SKILL.md")));

    writeFileSync(join(root, "bad.json"), JSON.stringify({
      task: { target: "start", goal: "done", unknown: true },
      workers: { main: { type: "pi", taskTypes: ["supervise"] } },
    }));
    assert.throws(() => loadTaskConfig(join(root, "bad.json")), /unknown field/);

    writeFileSync(join(root, "pi-args.json"), JSON.stringify({
      task: { target: "start", goal: "done" },
      workers: { main: { type: "pi", taskTypes: ["supervise"], args: ["--thinking", "high"] } },
    }));
    assert.throws(() => loadTaskConfig(join(root, "pi-args.json")), /not supported for Pi SDK workers/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
