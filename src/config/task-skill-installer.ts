import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { InstalledSkill, ResolvedTaskConfig, WorkerType } from "./types.js";

export interface SkillInstallOptions {
  agentsDir?: string;
  claudeDir?: string;
}

export function initializeTaskSkills(
  config: ResolvedTaskConfig,
  options: SkillInstallOptions = {},
): InstalledSkill[] {
  const sources = config.task.skills.map((name) => {
    assertSkillName(name);
    const source = resolve(config.taskDir, "skills", name);
    const entry = join(source, "SKILL.md");
    if (!existsSync(entry) || !lstatSync(entry).isFile()) {
      throw new Error(`task skill must contain SKILL.md: ${entry}`);
    }
    return { name, source: realpathSync(source) };
  });
  const roots = skillRoots(Object.values(config.workers).map((worker) => worker.type), options);
  return sources.map(({ name, source }) => {
    const targets = roots.map((root) => join(root, name));
    for (const target of targets) link(source, target);
    return { name, source, targets };
  });
}

export function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid skill name: ${name}`);
}

function skillRoots(types: WorkerType[], options: SkillInstallOptions): string[] {
  const roots = new Set<string>();
  if (types.includes("opencode") || types.includes("pi")) {
    roots.add(resolve(options.agentsDir ?? join(homedir(), ".agents", "skills")));
  }
  if (types.includes("claude-code")) {
    roots.add(resolve(options.claudeDir ?? join(homedir(), ".claude", "skills")));
  }
  return [...roots];
}

function link(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isSymbolicLink()) throw new Error(`refusing to replace existing skill: ${target}`);
    const current = resolve(dirname(target), readlinkSync(target));
    if (existsSync(current) && realpathSync(current) === source) return;
    unlinkSync(target);
  }
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}
