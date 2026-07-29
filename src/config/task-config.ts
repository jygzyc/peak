import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DEFAULT_PHASE, DEFAULT_SCHEDULER } from "./defaults.js";
import { resolveTaskConfigPaths, resolveTaskWorkspace } from "./paths.js";
import type { ProjectConfig, ResolvedTaskConfig, TaskType, WorkerConfig, WorkerType } from "./types.js";

const WORKER_TYPES: WorkerType[] = ["opencode", "codex", "pi", "claude-code"];
const TASK_TYPES: TaskType[] = ["plan", "supervise", "execute"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function persistProjectId(config: ResolvedTaskConfig, index: number, projectId: string): void {
  if (!UUID.test(projectId)) throw new Error(`invalid Project UUID: ${projectId}`);
  const root = object(parseJson(readFileSync(config.configPath, "utf8")), "task config");
  const board = object(root.board, "board");
  const projects = array(board.projects, "board.projects");
  const project = object(projects[index], `board.projects[${index}]`);
  const current = optionalUuid(project.id, `board.projects[${index}].id`);
  if (current && current !== projectId.toLowerCase()) throw new Error(`Project id was concurrently changed: ${current}`);
  project.id = projectId.toLowerCase();
  const temporary = `${config.configPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, config.configPath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

export function loadTaskConfig(directory = "."): ResolvedTaskConfig {
  const { configPath, taskDir } = resolveTaskConfigPaths(directory);
  if (!existsSync(configPath)) throw new Error(`task config not found: ${configPath}`);
  const root = object(parseJson(readFileSync(configPath, "utf8")), "task config");
  keys(root, ["board", "workers", "scheduler", "phase"], "task config");
  const board = object(root.board, "board");
  keys(board, ["name", "workspace", "skills", "projects"], "board");
  const workers = parseWorkers(root.workers);
  if (!Object.values(workers).some((worker) => worker.taskTypes.includes("supervise"))) {
    throw new Error("at least one worker must support supervise");
  }
  return deepFreeze({
    configPath,
    taskDir,
    board: {
      name: optionalString(board.name, "board.name"),
      workspace: resolveTaskWorkspace(taskDir, optionalString(board.workspace, "board.workspace")),
      skills: strings(board.skills, "board.skills") ?? [],
      projects: parseProjects(board.projects),
    },
    workers,
    scheduler: parseScheduler(root.scheduler),
    phase: parsePhase(root.phase),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function parseProjects(value: unknown): ProjectConfig[] {
  const input = array(value, "board.projects");
  if (input.length === 0) throw new Error("board.projects must not be empty");
  const names = new Set<string>();
  const ids = new Set<string>();
  return input.map((raw, index) => {
    const label = `board.projects[${index}]`;
    const project = object(raw, label);
    keys(project, ["id", "name", "goal"], label);
    const id = optionalUuid(project.id, `${label}.id`);
    const name = requiredString(project.name, `${label}.name`);
    if (names.has(name)) throw new Error(`duplicate Project name: ${name}`);
    if (id && ids.has(id)) throw new Error(`duplicate Project id: ${id}`);
    names.add(name);
    if (id) ids.add(id);
    return { id, name, goal: requiredString(project.goal, `${label}.goal`) };
  });
}

function parseWorkers(value: unknown): Record<string, WorkerConfig> {
  const input = array(value, "workers");
  if (input.length === 0) throw new Error("workers must not be empty");
  const output: Record<string, WorkerConfig> = {};
  input.forEach((raw, index) => {
    const name = `worker-${index + 1}`;
    const label = `workers[${index}]`;
    const worker = object(raw, label);
    keys(worker, ["type", "model", "taskTypes", "maxRunning", "priority", "args"], label);
    const type = enumeration(worker.type, WORKER_TYPES, `${label}.type`);
    output[name] = {
      type,
      model: optionalModel(worker.model, `${label}.model`),
      taskTypes: enumerations(worker.taskTypes, TASK_TYPES, `${label}.taskTypes`) ?? [...TASK_TYPES],
      maxRunning: integer(worker.maxRunning, `${label}.maxRunning`) ?? 1,
      priority: integer(worker.priority, `${label}.priority`, 0) ?? 1,
      args: strings(worker.args, `${label}.args`) ?? [],
    };
  });
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

function parsePhase(value: unknown): ResolvedTaskConfig["phase"] {
  if (value === undefined) return structuredClone(DEFAULT_PHASE);
  const input = object(value, "phase");
  keys(input, ["plan", "supervise", "execute"], "phase");
  const plan = section(input.plan, "phase.plan", ["maxIntents"]);
  const supervise = section(input.supervise, "phase.supervise", ["intervalMs"]);
  const execute = section(input.execute, "phase.execute", ["maxArtifactBytes"]);
  return {
    plan: {
      maxIntents: integer(plan.maxIntents, "phase.plan.maxIntents") ?? DEFAULT_PHASE.plan.maxIntents,
    },
    supervise: {
      intervalMs: integer(supervise.intervalMs, "phase.supervise.intervalMs") ?? DEFAULT_PHASE.supervise.intervalMs,
    },
    execute: {
      maxArtifactBytes: integer(execute.maxArtifactBytes, "phase.execute.maxArtifactBytes") ?? DEFAULT_PHASE.execute.maxArtifactBytes,
    },
  };
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

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
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

function optionalModel(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  return optionalString(value, label);
}

function optionalUuid(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const id = optionalString(value, label);
  if (!id || !UUID.test(id)) throw new Error(`${label} must be empty or a UUID`);
  return id.toLowerCase();
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
