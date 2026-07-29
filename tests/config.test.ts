import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializePeakPaths, resolveTaskConfigPaths } from "../dist/config/paths.js";
import { loadTaskConfig } from "../dist/config/task-config.js";
import { initializeTaskDirectory } from "../dist/config/task-initializer.js";
import { cleanupTaskSkills, initializeTaskSkills } from "../dist/config/task-skill-installer.js";

test("config owns configured paths and Board directory initialization", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-paths-"));
  try {
    assert.equal(resolveTaskConfigPaths().taskDir, process.cwd());
    const peak = initializePeakPaths(join(root, "peak-home"));
    assert.equal(peak.peakHome, join(root, "peak-home"));
    assert.ok(existsSync(peak.projectsDir));

    const task = initializeTaskDirectory(join(root, "task"));
    assert.ok(existsSync(task.configPath));
    assert.equal(existsSync(join(task.taskDir, "skills")), false);
    const initialized = loadTaskConfig(task.taskDir);
    assert.equal(initialized.board.workspace, task.taskDir);
    assert.deepEqual(initialized.board.skills, []);
    assert.deepEqual(initialized.board.projects, [
      { id: undefined, name: "Main", goal: "Describe what this Project must prove" },
    ]);
    assert.deepEqual(initializeTaskSkills(initialized, {
      agentsDir: join(root, "unused-agents"),
      claudeDir: join(root, "unused-claude"),
    }), []);
    assert.throws(() => initializeTaskDirectory(task.taskDir), /task already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config is strict and initializes Board skills", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-config-"));
  try {
    mkdirSync(join(root, "skills", "review"), { recursive: true });
    writeFileSync(join(root, "skills", "review", "SKILL.md"), "# Review\n");
    mkdirSync(join(root, "skills", "installed"), { recursive: true });
    writeFileSync(join(root, "skills", "installed", "SKILL.md"), "# Local fallback must not override global\n");
    const agents = join(root, "agents-skills");
    mkdirSync(join(agents, "installed"), { recursive: true });
    writeFileSync(join(agents, "installed", "SKILL.md"), "# Installed\n");
    writeFileSync(join(root, "task.json"), JSON.stringify({
      board: {
        workspace: ".",
        skills: ["review", "installed"],
        projects: [
          { id: "", name: "Research", goal: "collect research" },
          { id: "123e4567-e89b-42d3-a456-426614174000", name: "Delivery", goal: "prepare delivery" },
        ],
      },
      workers: [
        { type: "pi", taskTypes: ["plan", "supervise", "execute"] },
        { type: "codex", model: "", taskTypes: ["plan"], priority: 2 },
      ],
    }));
    const config = loadTaskConfig(root);
    assert.equal(config.board.workspace, root);
    assert.deepEqual(config.board.projects.map((project) => project.name), ["Research", "Delivery"]);
    assert.equal(config.board.projects[0]?.id, undefined);
    assert.equal(config.board.projects[1]?.id, "123e4567-e89b-42d3-a456-426614174000");
    assert.equal(Object.isFrozen(config.board.projects[0]), true);
    assert.equal(config.workers["worker-2"]?.model, undefined, "empty model selects the Agent tool default");
    assert.deepEqual(config.phase.plan, { maxIntents: 3 });
    assert.equal(config.phase.supervise.intervalMs, 60_000);
    const first = initializeTaskSkills(config, { agentsDir: agents, claudeDir: join(root, "claude-skills") });
    const second = initializeTaskSkills(config, { agentsDir: agents, claudeDir: join(root, "claude-skills") });
    assert.ok(existsSync(join(agents, "review", "SKILL.md")));
    assert.ok(existsSync(join(agents, "installed", "SKILL.md")));
    assert.deepEqual(first.find((skill) => skill.name === "installed")?.temporaryTargets, [], "global Skill must win over Task fallback");
    cleanupTaskSkills(first);
    assert.ok(existsSync(join(agents, "review", "SKILL.md")), "shared temporary link must remain leased");
    cleanupTaskSkills(second);
    assert.equal(existsSync(join(agents, "review")), false, "temporary Board-local link must be removed");
    assert.ok(existsSync(join(agents, "installed", "SKILL.md")), "preinstalled global Skill must remain");

    const badDir = join(root, "bad");
    mkdirSync(badDir);
    writeFileSync(join(badDir, "task.json"), JSON.stringify({
      board: { projects: [{ name: "Main", goal: "start" }], unknown: true },
      workers: [{ type: "pi", taskTypes: ["supervise"] }],
    }));
    assert.throws(() => loadTaskConfig(badDir), /unknown field/);

    const phaseTimeoutDir = join(root, "phase-timeout");
    mkdirSync(phaseTimeoutDir);
    writeFileSync(join(phaseTimeoutDir, "task.json"), JSON.stringify({
      board: { projects: [{ name: "Main", goal: "start" }] },
      workers: [{ type: "pi", taskTypes: ["supervise"] }],
      phase: { plan: { timeoutMs: 1_000 } },
    }));
    assert.throws(() => loadTaskConfig(phaseTimeoutDir), /phase\.plan contains unknown field "timeoutMs"/);

    const noProjectsDir = join(root, "no-projects");
    mkdirSync(noProjectsDir);
    writeFileSync(join(noProjectsDir, "task.json"), JSON.stringify({
      board: { projects: [] },
      workers: [{ type: "pi", taskTypes: ["supervise"] }],
    }));
    assert.throws(() => loadTaskConfig(noProjectsDir), /board\.projects must not be empty/);

    const duplicateDir = join(root, "duplicate-project");
    mkdirSync(duplicateDir);
    writeFileSync(join(duplicateDir, "task.json"), JSON.stringify({
      board: { projects: [{ name: "Same", goal: "one" }, { name: "Same", goal: "two" }] },
      workers: [{ type: "pi", taskTypes: ["supervise"] }],
    }));
    assert.throws(() => loadTaskConfig(duplicateDir), /duplicate Project name/);

    const badIdDir = join(root, "bad-project-id");
    mkdirSync(badIdDir);
    writeFileSync(join(badIdDir, "task.json"), JSON.stringify({
      board: { projects: [{ id: "not-a-uuid", name: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["supervise"] }],
    }));
    assert.throws(() => loadTaskConfig(badIdDir), /must be empty or a UUID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
