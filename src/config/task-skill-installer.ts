/** Install task-local Skills into the selected Agent CLI discovery folders. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TaskConfig, WorkerType } from "../agent/types.js";

export interface TaskSkillInstallOptions {
  agentsSkillsDir?: string;
  claudeSkillsDir?: string;
}

export interface InstalledTaskSkill {
  name: string;
  source: string;
  targets: string[];
}

export function installTaskSkills(
  config: TaskConfig,
  taskDir: string,
  options: TaskSkillInstallOptions = {},
): InstalledTaskSkill[] {
  const requirements = collectSkillRequirements(config);
  const installed: InstalledTaskSkill[] = [];

  for (const [name, workerTypes] of requirements) {
    const source = resolve(taskDir, "skills", name);
    requireSkillSource(name, source);
    const targets = skillTargets(workerTypes, options);
    for (const root of targets) linkSkill(source, join(root, name));
    installed.push({ name, source, targets: targets.map((root) => join(root, name)) });
  }

  return installed;
}

export function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`skill name must use lowercase letters, digits, and hyphens: ${name}`);
  }
}

function collectSkillRequirements(config: TaskConfig): Map<string, Set<WorkerType>> {
  const result = new Map<string, Set<WorkerType>>();
  for (const profile of Object.values(config.profiles)) {
    const skills = profile.prompt.skills ?? [];
    const workers = profile.runtime.workers?.length
      ? profile.runtime.workers
      : [profile.runtime.worker];
    for (const name of skills) {
      assertSkillName(name);
      const types = result.get(name) ?? new Set<WorkerType>();
      for (const workerName of workers) {
        const worker = config.workers[workerName];
        if (!worker) throw new Error(`skill "${name}" references missing worker "${workerName}"`);
        types.add(worker.type);
      }
      result.set(name, types);
    }
  }
  return result;
}

function requireSkillSource(name: string, source: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error(`task skill not found: ${name} (expected ${source})`);
  }
  const entrypoint = join(source, "SKILL.md");
  if (!existsSync(entrypoint) || !lstatSync(entrypoint).isFile()) {
    throw new Error(`task skill "${name}" must contain SKILL.md: ${entrypoint}`);
  }
}

function skillTargets(
  workerTypes: Set<WorkerType>,
  options: TaskSkillInstallOptions,
): string[] {
  const roots = new Set<string>();
  if (workerTypes.has("opencode") || workerTypes.has("pi")) {
    roots.add(resolve(options.agentsSkillsDir ?? join(homedir(), ".agents", "skills")));
  }
  if (workerTypes.has("claude-code")) {
    roots.add(resolve(options.claudeSkillsDir ?? join(homedir(), ".claude", "skills")));
  }
  return [...roots];
}

function linkSkill(source: string, target: string): void {
  const canonicalSource = realpathSync(source);
  if (resolve(target) === resolve(source)) return;
  mkdirSync(dirname(target), { recursive: true });

  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`cannot install task skill over an existing directory: ${target}`);
    }
    const current = resolve(dirname(target), readlinkSync(target));
    if (existsSync(current) && realpathSync(current) === canonicalSource) return;
    unlinkSync(target);
  }

  symlinkSync(canonicalSource, target, process.platform === "win32" ? "junction" : "dir");
}
