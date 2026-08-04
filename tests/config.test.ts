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
    assert.equal(initialized.taskDir, task.taskDir);
    assert.deepEqual(initialized.board.skills, []);
    assert.deepEqual(initialized.board.projects, [
      { id: undefined, source: "Describe the source material or starting state", goal: "Describe what this Project must prove" },
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
        skills: ["review", "installed"],
        projects: [
          { id: "", source: "Research inputs", goal: "collect research" },
          { id: "123e4567-e89b-42d3-a456-426614174000", source: "Delivery inputs", goal: "prepare delivery" },
        ],
      },
      workers: [
        { type: "pi", taskTypes: ["plan", "supervise", "execute"] },
        { type: "codex", model: "", taskTypes: ["plan"], priority: 2 },
      ],
    }));
    const config = loadTaskConfig(root);
    assert.equal(config.taskDir, root);
    assert.deepEqual(config.board.projects.map((project) => project.source), ["Research inputs", "Delivery inputs"]);
    assert.equal(config.board.projects[0]?.id, undefined);
    assert.equal(config.board.projects[1]?.id, "123e4567-e89b-42d3-a456-426614174000");
    assert.equal(Object.isFrozen(config.board.projects[0]), true);
    assert.equal(config.workers["worker-2"]?.model, undefined, "empty model selects the Agent tool default");
    assert.deepEqual(config.phase.plan, {});
    assert.equal(config.phase.supervise.intervalMs, 60_000);
    assert.equal(config.phase.execute.maxArtifactBytes, 10 * 1024 * 1024);
    assert.deepEqual(config.workers["worker-1"]?.env, {}, "workers default to an empty env map");
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
      board: { projects: [{ source: "Main", goal: "start" }], unknown: true },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
    }));
    assert.throws(() => loadTaskConfig(badDir), /unknown field/);

    const phaseTimeoutDir = join(root, "phase-timeout");
    mkdirSync(phaseTimeoutDir);
    writeFileSync(join(phaseTimeoutDir, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Main", goal: "start" }] },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
      phase: { plan: { timeoutMs: 1_000 } },
    }));
    assert.throws(() => loadTaskConfig(phaseTimeoutDir), /phase\.plan contains unknown field "timeoutMs"/);

    const noProjectsDir = join(root, "no-projects");
    mkdirSync(noProjectsDir);
    writeFileSync(join(noProjectsDir, "task.json"), JSON.stringify({
      board: { projects: [] },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
    }));
    assert.throws(() => loadTaskConfig(noProjectsDir), /board\.projects must not be empty/);

    const duplicateDir = join(root, "duplicate-project");
    mkdirSync(duplicateDir);
    writeFileSync(join(duplicateDir, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Same", goal: "one" }, { source: "Same", goal: "two" }] },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
    }));
    assert.throws(() => loadTaskConfig(duplicateDir), /duplicate Project source/);

    const badIdDir = join(root, "bad-project-id");
    mkdirSync(badIdDir);
    writeFileSync(join(badIdDir, "task.json"), JSON.stringify({
      board: { projects: [{ id: "not-a-uuid", source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
    }));
    assert.throws(() => loadTaskConfig(badIdDir), /must be empty or a UUID/);

    const promptsDir = join(root, "custom-prompts");
    mkdirSync(promptsDir);
    const promptTask = {
      board: { projects: [{ source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["supervise", "execute"] }],
      phase: {
        plan: { customProfile: { description: "Use for security planning.", prompt: "Plan every proof edge." } },
        supervise: { customProfile: { description: "Use for proof review.", prompt: "Check every proof edge." } },
        execute: { maxArtifactBytes: 2_048, customProfiles: [{ description: "Use for primary research.", prompt: "Collect primary evidence." }] },
      },
    };
    writeFileSync(join(promptsDir, "task.json"), JSON.stringify(promptTask));
    const promptConfig = loadTaskConfig(promptsDir);
    assert.deepEqual(promptConfig.phase.plan, {
      customProfile: { description: "Use for security planning.", prompt: "Plan every proof edge." },
    });
    assert.deepEqual(promptConfig.phase.supervise, {
      intervalMs: 60_000,
      customProfile: { description: "Use for proof review.", prompt: "Check every proof edge." },
    });
    assert.deepEqual(promptConfig.phase.execute.customProfiles, [
      { description: "Use for primary research.", prompt: "Collect primary evidence." },
    ]);
    assert.equal(promptConfig.phase.execute.maxArtifactBytes, 2_048);
    (promptTask.phase.supervise.customProfile as { description: string; prompt?: string }).prompt = undefined;
    writeFileSync(join(promptsDir, "task.json"), JSON.stringify(promptTask));
    assert.throws(() => loadTaskConfig(promptsDir), /customProfile\.prompt is required/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config parses worker env and rejects removed scheduler/args fields", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-env-"));
  try {
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Main", goal: "done" }] },
      workers: [
        { type: "pi", taskTypes: ["plan", "supervise"], env: { PI_MODEL: "deepseek/v4", ANTHROPIC_API_KEY: "sk-test" } },
        { type: "codex", taskTypes: ["execute"], maxRunning: 2, env: { CODEX_MODEL: "gpt-5" } },
      ],
    }));
    const config = loadTaskConfig(root);
    assert.deepEqual(config.workers["worker-1"]?.env, { PI_MODEL: "deepseek/v4", ANTHROPIC_API_KEY: "sk-test" });
    assert.deepEqual(config.workers["worker-2"]?.env, { CODEX_MODEL: "gpt-5" });
    assert.equal(config.scheduler.maxRunningProjects, 4);
    assert.equal(config.scheduler.intervalMs, 3_000);

    const argsDir = join(root, "args");
    mkdirSync(argsDir);
    writeFileSync(join(argsDir, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"], args: ["--thinking", "high"] }],
    }));
    assert.throws(() => loadTaskConfig(argsDir), /unknown field "args"/);

    const schedulerDir = join(root, "scheduler");
    mkdirSync(schedulerDir);
    writeFileSync(join(schedulerDir, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
      scheduler: { maxConcurrent: 4 },
    }));
    assert.throws(() => loadTaskConfig(schedulerDir), /unknown field "maxConcurrent"/);

    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    writeFileSync(join(workspaceDir, "task.json"), JSON.stringify({
      board: { workspace: "./work", projects: [{ source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
    }));
    assert.throws(() => loadTaskConfig(workspaceDir), /unknown field "workspace"/);

    const planDir = join(root, "plan");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise", "execute"] }],
      phase: { plan: { maxIntents: 4 } },
    }));
    assert.throws(() => loadTaskConfig(planDir), /phase\.plan contains unknown field "maxIntents"/);

    const noExecuteDir = join(root, "no-execute");
    mkdirSync(noExecuteDir);
    writeFileSync(join(noExecuteDir, "task.json"), JSON.stringify({
      board: { projects: [{ source: "Main", goal: "done" }] },
      workers: [{ type: "pi", taskTypes: ["plan", "supervise"] }],
    }));
    assert.throws(() => loadTaskConfig(noExecuteDir), /at least one worker must support execute/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
