import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WORKER_REGISTRY } from "../worker/registry.js";
import type { WorkerType } from "../worker/types.js";
import type { SkillInstallOptions } from "./types.js";

export interface PeakPaths {
  peakHome: string;
  projectsDir: string;
}

export interface TaskConfigPaths {
  configPath: string;
  taskDir: string;
}

export interface SkillDirectories {
  agentsDir: string;
  claudeDir: string;
}

export function initializePeakPaths(override?: string): PeakPaths {
  const peakHome = resolve(override ?? process.env.PEAK_HOME ?? join(homedir(), ".peak"));
  const projectsDir = initializeProjectsDirectory(join(peakHome, "projects"));
  return Object.freeze({ peakHome, projectsDir });
}

export function initializeProjectsDirectory(path: string): string {
  return initializeDirectory(path);
}

export function initializeProjectDirectory(path: string): string {
  return initializeDirectory(path);
}

export function initializeArtifactDirectory(projectDir: string): string {
  return initializeDirectory(join(projectDir, "artifacts"));
}

export function initializeProjectLogsDirectory(projectDir: string): string {
  return initializeDirectory(join(projectDir, "logs"));
}

function initializeDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Name of the per-Project runtime scratch directory for transient worker files. */
export const PROJECT_TMP_DIR = ".tmp";

/**
 * Per-Project runtime scratch directory (`<projectDir>/.tmp`) used as the
 * Worker subprocess cwd and for transient files such as CLI session caches.
 * It is never persisted to a Project archive, never stores Fact Artifacts or
 * deliverables, and is cleaned up once the Project is no longer active.
 */
export function projectTmpDir(projectDir: string): string {
  return join(resolve(projectDir), PROJECT_TMP_DIR);
}

/** Name of the per-Project deliverable output directory. */
export const PROJECT_OUT_DIR = "out";

/**
 * Per-Project output directory (`<projectDir>/out`) where the final Goal
 * deliverables are materialized using each completion-source Artifact's
 * content-based filename. Distinct from the content-addressed `artifacts/`
 * store: `artifacts/` is the immutable source of truth, while `out/` holds the
 * user-facing materialized copies. It is never persisted to a Project archive
 * (deliverables are reproducible from the archived Artifacts) and is removed
 * only when the Project itself is deleted.
 */
export function projectOutDir(projectDir: string): string {
  return join(resolve(projectDir), PROJECT_OUT_DIR);
}

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Absolute path of one Project's shard directory under a Projects root, after
 * validating the UUID. Replaces the former thin `ProjectManager` wrapper; the
 * only logic it carried was this validation plus the path join.
 */
export function projectDir(projectsDir: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("invalid project id");
  return join(resolve(projectsDir), projectId);
}

/** Accepts a Board directory or a direct path to its task.json file. */
export function resolveTaskConfigPaths(path = "."): TaskConfigPaths {
  const resolved = resolve(path);
  if (statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    return Object.freeze({ configPath: resolved, taskDir: dirname(resolved) });
  }
  return Object.freeze({ configPath: join(resolved, "task.json"), taskDir: resolved });
}

export function resolveTaskSkillSource(taskDir: string, name: string): string {
  return resolve(taskDir, "skills", name);
}

export function resolveSkillDirectories(options: SkillInstallOptions = {}): SkillDirectories {
  return Object.freeze({
    agentsDir: resolve(options.agentsDir ?? join(homedir(), ".agents", "skills")),
    claudeDir: resolve(options.claudeDir ?? join(homedir(), ".claude", "skills")),
  });
}

export function resolveSkillInstallRoots(
  types: WorkerType[],
  options: SkillInstallOptions = {},
): string[] {
  const paths = resolveSkillDirectories(options);
  const directories = { agents: paths.agentsDir, claude: paths.claudeDir };
  const roots = new Set<string>();
  for (const type of new Set(types)) {
    for (const directory of WORKER_REGISTRY[type]?.skillDirectories ?? []) roots.add(directories[directory]);
  }
  return [...roots];
}
