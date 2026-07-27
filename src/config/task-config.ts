import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_SCHEDULER, DEFAULT_TASKS } from "./defaults.js";
import type { ResolvedTaskConfig, TaskType, WorkerConfig, WorkerType } from "./types.js";

const WORKER_TYPES: WorkerType[] = ["opencode", "codex", "pi", "claude-code"];
const TASK_TYPES: TaskType[] = ["plan", "supervise", "execute"];

export function loadTaskConfig(path: string): ResolvedTaskConfig {
  const configPath = resolve(path);
  if (!existsSync(configPath)) throw new Error(`task config not found: ${configPath}`);
  const root = object(parseJson(readFileSync(configPath, "utf8")), "task config");
  keys(root, ["task", "workers", "scheduler", "tasks", "federation"], "task config");
  const taskDir = dirname(configPath);
  const task = object(root.task, "task");
  keys(task, ["name", "target", "goal", "workspace", "skills"], "task");
  const workers = parseWorkers(root.workers);
  if (!Object.values(workers).some((worker) => worker.taskTypes.includes("supervise"))) {
    throw new Error("at least one worker must support supervise");
  }
  return deepFreeze({
    configPath,
    taskDir,
    task: {
      name: optionalString(task.name, "task.name"),
      target: requiredString(task.target, "task.target"),
      goal: requiredString(task.goal, "task.goal"),
      workspace: resolve(taskDir, optionalString(task.workspace, "task.workspace") ?? "."),
      skills: strings(task.skills, "task.skills") ?? [],
    },
    workers,
    scheduler: parseScheduler(root.scheduler),
    tasks: parseTasks(root.tasks),
    federation: parseFederation(root.federation),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function parseWorkers(value: unknown): Record<string, WorkerConfig> {
  const input = object(value, "workers");
  if (Object.keys(input).length === 0) throw new Error("workers must not be empty");
  const output: Record<string, WorkerConfig> = {};
  for (const [name, raw] of Object.entries(input)) {
    const worker = object(raw, `worker ${name}`);
    keys(worker, ["type", "model", "taskTypes", "maxRunning", "priority", "args"], `worker ${name}`);
    const type = enumeration(worker.type, WORKER_TYPES, `worker ${name}.type`);
    const args = strings(worker.args, `worker ${name}.args`) ?? [];
    if (type === "pi" && args.length) throw new Error(`worker ${name}.args is not supported for Pi SDK workers`);
    output[name] = {
      type,
      model: optionalString(worker.model, `worker ${name}.model`),
      taskTypes: enumerations(worker.taskTypes, TASK_TYPES, `worker ${name}.taskTypes`) ?? [...TASK_TYPES],
      maxRunning: integer(worker.maxRunning, `worker ${name}.maxRunning`) ?? 1,
      priority: integer(worker.priority, `worker ${name}.priority`, 0) ?? 1,
      args,
    };
  }
  return output;
}

function parseScheduler(value: unknown): ResolvedTaskConfig["scheduler"] {
  if (value === undefined) return { ...DEFAULT_SCHEDULER };
  const input = object(value, "scheduler");
  keys(input, Object.keys(DEFAULT_SCHEDULER), "scheduler");
  return {
    maxConcurrent: integer(input.maxConcurrent, "scheduler.maxConcurrent") ?? DEFAULT_SCHEDULER.maxConcurrent,
    maxRunningProjects: integer(input.maxRunningProjects, "scheduler.maxRunningProjects") ?? DEFAULT_SCHEDULER.maxRunningProjects,
    maxProjectConcurrent: integer(input.maxProjectConcurrent, "scheduler.maxProjectConcurrent") ?? DEFAULT_SCHEDULER.maxProjectConcurrent,
    refillPerTick: integer(input.refillPerTick, "scheduler.refillPerTick") ?? DEFAULT_SCHEDULER.refillPerTick,
    intervalMs: integer(input.intervalMs, "scheduler.intervalMs") ?? DEFAULT_SCHEDULER.intervalMs,
  };
}

function parseTasks(value: unknown): ResolvedTaskConfig["tasks"] {
  if (value === undefined) return structuredClone(DEFAULT_TASKS);
  const input = object(value, "tasks");
  keys(input, ["plan", "supervise", "execute"], "tasks");
  const plan = section(input.plan, "tasks.plan", ["timeoutMs", "maxIntents"]);
  const supervise = section(input.supervise, "tasks.supervise", ["timeoutMs", "intervalMs"]);
  const execute = section(input.execute, "tasks.execute", ["timeoutMs", "finalizeTimeoutMs", "maxArtifactBytes"]);
  return {
    plan: {
      timeoutMs: integer(plan.timeoutMs, "tasks.plan.timeoutMs") ?? DEFAULT_TASKS.plan.timeoutMs,
      maxIntents: integer(plan.maxIntents, "tasks.plan.maxIntents") ?? DEFAULT_TASKS.plan.maxIntents,
    },
    supervise: {
      timeoutMs: integer(supervise.timeoutMs, "tasks.supervise.timeoutMs") ?? DEFAULT_TASKS.supervise.timeoutMs,
      intervalMs: integer(supervise.intervalMs, "tasks.supervise.intervalMs") ?? DEFAULT_TASKS.supervise.intervalMs,
    },
    execute: {
      timeoutMs: integer(execute.timeoutMs, "tasks.execute.timeoutMs") ?? DEFAULT_TASKS.execute.timeoutMs,
      finalizeTimeoutMs: integer(execute.finalizeTimeoutMs, "tasks.execute.finalizeTimeoutMs") ?? DEFAULT_TASKS.execute.finalizeTimeoutMs,
      maxArtifactBytes: integer(execute.maxArtifactBytes, "tasks.execute.maxArtifactBytes") ?? DEFAULT_TASKS.execute.maxArtifactBytes,
    },
  };
}

function parseFederation(value: unknown): ResolvedTaskConfig["federation"] {
  if (value === undefined) return undefined;
  const input = object(value, "federation");
  keys(input, ["scope"], "federation");
  return { scope: optionalString(input.scope, "federation.scope") };
}

function section(value: unknown, label: string, allowed: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  const result = object(value, label);
  keys(result, allowed, label);
  return result;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new Error(`invalid task JSON: ${(error as Error).message}`); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const invalid = Object.keys(value).find((key) => !allowed.includes(key));
  if (invalid) throw new Error(`${label} contains unknown field "${invalid}"`);
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function strings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...new Set(value.map((item) => requiredString(item, label)))];
}

function integer(value: unknown, label: string, minimum = 1): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return value as number;
}

function enumeration<T extends string>(value: unknown, allowed: T[], label: string): T {
  const result = requiredString(value, label);
  if (!allowed.includes(result as T)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  return result as T;
}

function enumerations<T extends string>(value: unknown, allowed: T[], label: string): T[] | undefined {
  const values = strings(value, label);
  return values?.map((item) => enumeration(item, allowed, label));
}
