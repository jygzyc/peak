/** Load a project-local task file and its optional reusable Agent bundle. */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SchedulerConfig, TaskConfig, WorkerConfig, WorkerName } from "../agent/types.js";
import { DEFAULT_SCHEDULER } from "../agent/types.js";
import { loadAgent } from "./agent-loader.js";
import { defaultConfig } from "./default-config.js";

export interface LoadedConfig {
  config: TaskConfig;
  session: string;
  sessionDir: string;
  workspaceDir: string;
  configPath: string;
}

export function loadConfig(
  configPath: string,
  sessionOverride?: string,
): LoadedConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) throw new Error(`task config not found: ${absPath}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (error) {
    throw new Error(`task config is not valid JSON: ${(error as Error).message}`);
  }
  const root = objectValue(parsed, "task config");
  assertKeys(root, ["task", "agent", "workers", "scheduler", "federation"], "task config");
  const task = objectValue(root.task, "task config.task");
  assertKeys(task, ["target", "goal", "name", "workspace"], "task config.task");

  const target = requiredString(task.target, "task.target");
  const goal = requiredString(task.goal, "task.goal");
  const name = optionalString(task.name, "task.name");
  const workspace = optionalString(task.workspace, "task.workspace");
  const agent = optionalString(root.agent, "task config.agent");
  const taskDir = dirname(absPath);
  const workspaceDir = workspace ? resolve(taskDir, workspace) : taskDir;
  const native = defaultConfig();
  const profiles = agent ? loadAgent(agent, taskDir) : native.profiles;
  const workers = parseWorkers(root.workers, native.workers);
  validateProfileWorkers(profiles, workers);

  const config: TaskConfig = {
    task: { target, goal, name, workspace: workspaceDir },
    ...(agent ? { agent } : {}),
    profiles,
    workers,
    scheduler: parseScheduler(root.scheduler),
    federation: parseFederation(root.federation),
  };
  const session = sessionOverride ?? name ?? deriveSessionFromTarget(target) ?? deriveSessionName(absPath);
  return { config, session, sessionDir: taskDir, workspaceDir, configPath: absPath };
}

function parseWorkers(
  raw: unknown,
  native: Record<WorkerName, WorkerConfig>,
): Record<WorkerName, WorkerConfig> {
  if (raw === undefined) return { ...native };
  const workers = objectValue(raw, "task config.workers");
  const result: Record<WorkerName, WorkerConfig> = {};
  for (const [name, value] of Object.entries(workers)) {
    const worker = objectValue(value, `worker "${name}"`);
    assertKeys(worker, ["type", "model", "args", "timeoutMs"], `worker "${name}"`);
    result[name] = {
      type: requiredEnum(
        worker.type,
        ["opencode", "codex", "pi", "claude-code"],
        `worker "${name}".type`,
      ),
      model: optionalString(worker.model, `worker "${name}".model`),
      args: optionalStrings(worker.args, `worker "${name}".args`),
      timeoutMs: optionalPositiveInt(worker.timeoutMs, `worker "${name}".timeoutMs`),
    };
  }
  return result;
}

function parseScheduler(raw: unknown): SchedulerConfig {
  if (raw === undefined) return { ...DEFAULT_SCHEDULER };
  const value = objectValue(raw, "task config.scheduler");
  assertKeys(value, ["maxConcurrent", "refillPerTick"], "task config.scheduler");
  return {
    maxConcurrent: optionalPositiveInt(value.maxConcurrent, "scheduler.maxConcurrent") ?? DEFAULT_SCHEDULER.maxConcurrent,
    refillPerTick: optionalPositiveInt(value.refillPerTick, "scheduler.refillPerTick") ?? DEFAULT_SCHEDULER.refillPerTick,
  };
}

function parseFederation(raw: unknown): TaskConfig["federation"] {
  if (raw === undefined) return undefined;
  const value = objectValue(raw, "task config.federation");
  assertKeys(value, ["scope"], "task config.federation");
  return {
    scope: optionalString(value.scope, "federation.scope"),
  };
}

function validateProfileWorkers(
  profiles: TaskConfig["profiles"],
  workers: TaskConfig["workers"],
): void {
  for (const [profileId, profile] of Object.entries(profiles)) {
    const names = profile.runtime.workers ?? [profile.runtime.worker];
    for (const name of names) {
      if (!workers[name]) throw new Error(`agent role "${profileId}" references missing worker "${name}"`);
    }
  }
}

function deriveSessionFromTarget(target: string): string | undefined {
  const stem = basename(target.replace(/[\\/]/g, "/")).replace(/\.[^.]+$/, "");
  const safe = stem.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || undefined;
}

function deriveSessionName(path: string): string {
  return basename(dirname(path)).replace(/[^a-zA-Z0-9_-]/g, "-") || "session";
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}"`);
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (!result) throw new Error(`${label} is required in task config`);
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  const parsed = optionalString(value, label);
  if (parsed === undefined) return undefined;
  if (!allowed.includes(parsed as T)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  return parsed as T;
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const parsed = optionalEnum(value, allowed, label);
  if (!parsed) throw new Error(`${label} is required`);
  return parsed;
}
