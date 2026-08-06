import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DEFAULT_PHASE, DEFAULT_SCHEDULER } from "./defaults.js";
import { resolveTaskConfigPaths } from "./paths.js";
import { TASK_TYPES, WORKER_TYPES } from "../worker/registry.js";
import type { CustomProfileDefinition, ProjectConfig, ResolvedTaskConfig, WorkerConfig } from "./types.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROFILE_DESCRIPTION_BYTES = 1024;
const MAX_CUSTOM_PROMPT_BYTES = 8 * 1024;

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
  keys(board, ["name", "skills", "projects"], "board");
  const workers = parseWorkers(root.workers);
  if (!Object.values(workers).some((worker) => worker.taskTypes.includes("supervise"))) {
    throw new Error("at least one worker must support supervise");
  }
  if (!Object.values(workers).some((worker) => worker.taskTypes.includes("execute"))) {
    throw new Error("at least one worker must support execute");
  }
  return deepFreeze({
    configPath,
    taskDir,
    board: {
      name: optionalString(board.name, "board.name"),
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
  const sources = new Set<string>();
  const ids = new Set<string>();
  return input.map((raw, index) => {
    const label = `board.projects[${index}]`;
    const project = object(raw, label);
    keys(project, ["id", "source", "goal"], label);
    const id = optionalUuid(project.id, `${label}.id`);
    const source = projectDescription(project.source, `${label}.source`);
    if (sources.has(source)) throw new Error(`duplicate Project source: ${source}`);
    if (id && ids.has(id)) throw new Error(`duplicate Project id: ${id}`);
    sources.add(source);
    if (id) ids.add(id);
    return { id, source, goal: projectDescription(project.goal, `${label}.goal`) };
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
    keys(worker, ["type", "model", "taskTypes", "maxRunning", "priority", "env"], label);
    const type = enumeration(worker.type, WORKER_TYPES, `${label}.type`);
    output[name] = {
      type,
      model: optionalModel(worker.model, `${label}.model`),
      taskTypes: enumerations(worker.taskTypes, TASK_TYPES, `${label}.taskTypes`) ?? [...TASK_TYPES],
      maxRunning: integer(worker.maxRunning, `${label}.maxRunning`) ?? 1,
      priority: integer(worker.priority, `${label}.priority`, 0) ?? 1,
      env: stringRecord(worker.env, `${label}.env`),
    };
  });
  return output;
}

function parseScheduler(value: unknown): ResolvedTaskConfig["scheduler"] {
  if (value === undefined) return { ...DEFAULT_SCHEDULER };
  const input = object(value, "scheduler");
  keys(input, Object.keys(DEFAULT_SCHEDULER), "scheduler");
  return {
    maxRunningProjects: integer(input.maxRunningProjects, "scheduler.maxRunningProjects") ?? DEFAULT_SCHEDULER.maxRunningProjects,
    intervalMs: integer(input.intervalMs, "scheduler.intervalMs") ?? DEFAULT_SCHEDULER.intervalMs,
  };
}

function parsePhase(value: unknown): ResolvedTaskConfig["phase"] {
  if (value === undefined) return structuredClone(DEFAULT_PHASE);
  const input = object(value, "phase");
  keys(input, ["plan", "supervise", "execute"], "phase");
  const plan = section(input.plan, "phase.plan", ["customProfile"]);
  const supervise = section(input.supervise, "phase.supervise", ["intervalMs", "customProfile"]);
  const execute = section(input.execute, "phase.execute", ["maxArtifactBytes", "customProfile"]);
  return {
    plan: {
      ...optionalCustomProfile(plan.customProfile, "phase.plan.customProfile"),
    },
    supervise: {
      intervalMs: integer(supervise.intervalMs, "phase.supervise.intervalMs") ?? DEFAULT_PHASE.supervise.intervalMs,
      ...optionalCustomProfile(supervise.customProfile, "phase.supervise.customProfile"),
    },
    execute: {
      maxArtifactBytes: integer(execute.maxArtifactBytes, "phase.execute.maxArtifactBytes") ?? DEFAULT_PHASE.execute.maxArtifactBytes,
      customProfile: customProfileList(execute.customProfile, "phase.execute.customProfile"),
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

function projectDescription(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (Buffer.byteLength(result, "utf8") > 4 * 1024) throw new Error(`${label} exceeds 4 KiB`);
  return result;
}

function optionalPrompt(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = requiredString(value, label);
  if (Buffer.byteLength(result, "utf8") > MAX_CUSTOM_PROMPT_BYTES) throw new Error(`${label} exceeds 8 KiB`);
  return result;
}

function optionalCustomProfile(value: unknown, label: string): { customProfile?: CustomProfileDefinition } {
  return value === undefined ? {} : { customProfile: customProfile(value, label) };
}

function customProfile(value: unknown, label: string): CustomProfileDefinition {
  const item = object(value, label);
  keys(item, ["description", "prompt"], label);
  const description = requiredString(item.description, `${label}.description`);
  if (Buffer.byteLength(description, "utf8") > MAX_PROFILE_DESCRIPTION_BYTES) throw new Error(`${label}.description exceeds 1 KiB`);
  const prompt = optionalPrompt(item.prompt, `${label}.prompt`);
  if (!prompt) throw new Error(`${label}.prompt is required`);
  return { description, prompt };
}

function customProfileList(value: unknown, label: string): CustomProfileDefinition[] {
  if (value === undefined) return [];
  const items = array(value, label);
  const seen = new Set<string>();
  return items.map((value, index) => {
    const itemLabel = `${label}[${index}]`;
    const profile = customProfile(value, itemLabel);
    if (seen.has(profile.description)) throw new Error(`duplicate Execute custom profile description: ${profile.description}`);
    seen.add(profile.description);
    return profile;
  });
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

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entryLabel = `${label}.${key}`;
    const trimmedKey = optionalString(key, entryLabel);
    if (!trimmedKey) throw new Error(`${entryLabel} has an empty key`);
    if (typeof raw !== "string" || raw === "") throw new Error(`${entryLabel} must be a non-empty string`);
    output[trimmedKey] = raw;
  }
  return output;
}

/**
 * The single source of Intent-generation and Execute-concurrency capacity:
 * the sum of `maxRunning` over every Worker whose `taskTypes` includes
 * `execute`. Plan may create at most this many Intents in one round, and the
 * Runtime may run at most this many Executes concurrently.
 */
export function executeCapacity(config: ResolvedTaskConfig): number {
  return Object.values(config.workers)
    .filter((worker) => worker.taskTypes.includes("execute"))
    .reduce((sum, worker) => sum + worker.maxRunning, 0);
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
