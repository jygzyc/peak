import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveSkillInstallRoots, resolveTaskSkillSource } from "./paths.js";
import type { InstalledSkill, ResolvedTaskConfig, SkillInstallOptions } from "./types.js";

interface ManagedLink { source: string; references: number }
const managedLinks = new Map<string, ManagedLink>();
const releasedInstallations = new WeakSet<InstalledSkill[]>();

export function initializeTaskSkills(
  config: ResolvedTaskConfig,
  options: SkillInstallOptions = {},
): InstalledSkill[] {
  if (config.board.skills.length === 0) return [];
  const workerTypes = Object.values(config.workers).map((worker) => worker.type);
  const roots = resolveSkillInstallRoots(workerTypes, options);
  const acquired: string[] = [];
  try {
    return config.board.skills.map((name) => {
      assertSkillName(name);
      const targets: string[] = [];
      const temporaryTargets: string[] = [];
      let localSource: string | undefined;
      for (const root of roots) {
        const target = resolve(root, name);
        targets.push(target);
        const managed = managedLinks.get(target);
        if (managed) {
          requireSkill(target, name);
          managed.references++;
          acquired.push(target);
          temporaryTargets.push(target);
          continue;
        }
        if (lstatSync(target, { throwIfNoEntry: false })) {
          requireSkill(target, name);
          continue;
        }
        localSource ??= requireSkill(resolveTaskSkillSource(config.taskDir, name), name);
        createLink(localSource, target);
        managedLinks.set(target, { source: localSource, references: 1 });
        acquired.push(target);
        temporaryTargets.push(target);
      }
      return { name, targets, temporaryTargets };
    });
  } catch (error) {
    releaseTargets(acquired);
    throw error;
  }
}

export function cleanupTaskSkills(skills: InstalledSkill[]): void {
  if (releasedInstallations.has(skills)) return;
  releasedInstallations.add(skills);
  releaseTargets(skills.flatMap((skill) => skill.temporaryTargets));
}

export function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid skill name: ${name}`);
}

function requireSkill(source: string, name: string): string {
  const entry = join(source, "SKILL.md");
  if (!existsSync(entry) || !lstatSync(entry).isFile()) {
    throw new Error(`configured skill is not globally installed and Board-local Skill is missing: ${name} (${entry})`);
  }
  return realpathSync(source);
}

function createLink(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

function releaseTargets(targets: string[]): void {
  for (const target of [...targets].reverse()) {
    const managed = managedLinks.get(target);
    if (!managed) continue;
    managed.references--;
    if (managed.references > 0) continue;
    managedLinks.delete(target);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) continue;
    try {
      if (realpathSync(target) === managed.source) unlinkSync(target);
    } catch {
      // Never remove a target that no longer resolves to the link Peak created.
    }
  }
}
