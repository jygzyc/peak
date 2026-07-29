import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillInstallOptions, WorkerType } from "./types.js";

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
  const projectsDir = resolve(path);
  mkdirSync(projectsDir, { recursive: true });
  return projectsDir;
}

export function initializeProjectDirectory(path: string): string {
  const projectDir = resolve(path);
  mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

export function initializeArtifactDirectory(projectDir: string): string {
  const artifactsDir = join(resolve(projectDir), "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  return artifactsDir;
}

export function initializeProjectLogsDirectory(projectDir: string): string {
  const logsDir = join(resolve(projectDir), "logs");
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function initializeExecutionInputDirectory(executionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(executionId)) throw new Error("invalid execution id");
  const inputDir = join(tmpdir(), "peak-inputs", executionId);
  mkdirSync(inputDir, { recursive: true });
  return inputDir;
}

export function resolveTaskConfigPaths(directory = "."): TaskConfigPaths {
  const taskDir = resolve(directory);
  const configPath = join(taskDir, "task.json");
  return Object.freeze({ configPath, taskDir });
}

export function resolveTaskWorkspace(taskDir: string, workspace?: string): string {
  return resolve(taskDir, workspace ?? ".");
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
  const roots = new Set<string>();
  if (types.includes("opencode") || types.includes("pi")) roots.add(paths.agentsDir);
  if (types.includes("claude-code")) roots.add(paths.claudeDir);
  return [...roots];
}
