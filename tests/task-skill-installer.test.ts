import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TaskConfig } from "../dist/agent/types.js";
import { installTaskSkills } from "../dist/config/task-skill-installer.js";
import { minimalConfig } from "./helper.ts";

function taskWithSkills(root: string): TaskConfig {
  for (const name of ["decx-cli", "app-vulnhunt"]) {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  }
  const config = minimalConfig();
  config.workers = {
    open: { type: "opencode" },
    pi: { type: "pi" },
    claude: { type: "claude-code" },
  };
  config.profiles.planner!.runtime = { worker: "open" };
  config.profiles.planner!.prompt.skills = ["decx-cli", "app-vulnhunt"];
  config.profiles.explorer!.runtime = { worker: "pi" };
  config.profiles.explorer!.prompt.skills = ["app-vulnhunt"];
  config.profiles.evaluator!.runtime = { worker: "claude" };
  config.profiles.evaluator!.prompt.skills = ["app-vulnhunt"];
  return config;
}

test("installTaskSkills links task Skills for OpenCode/Pi and Claude Code", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-task-skills-"));
  const agents = join(root, "installed-agents");
  const claude = join(root, "installed-claude");
  const config = taskWithSkills(root);

  const first = installTaskSkills(config, root, {
    agentsSkillsDir: agents,
    claudeSkillsDir: claude,
  });
  const second = installTaskSkills(config, root, {
    agentsSkillsDir: agents,
    claudeSkillsDir: claude,
  });

  assert.equal(first.length, 2);
  assert.equal(second.length, 2, "installation is idempotent");
  for (const target of [
    join(agents, "decx-cli"),
    join(agents, "app-vulnhunt"),
    join(claude, "app-vulnhunt"),
  ]) {
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(realpathSync(target), realpathSync(join(root, "skills", target.endsWith("decx-cli") ? "decx-cli" : "app-vulnhunt")));
  }
  assert.equal(lstatSync(join(claude, "decx-cli"), { throwIfNoEntry: false }), undefined);
});

test("installTaskSkills validates sources and never overwrites a real directory", () => {
  const root = mkdtempSync(join(tmpdir(), "peak-task-skills-"));
  const agents = join(root, "installed-agents");
  const config = taskWithSkills(root);
  mkdirSync(join(agents, "app-vulnhunt"), { recursive: true });

  assert.throws(
    () => installTaskSkills(config, root, { agentsSkillsDir: agents }),
    /existing directory/,
  );

  const missingRoot = mkdtempSync(join(tmpdir(), "peak-task-skills-missing-"));
  assert.throws(
    () => installTaskSkills(config, missingRoot, { agentsSkillsDir: agents }),
    /task skill not found/,
  );
});
