/**
 * task.json loader and merger.
 *
 * Reads a user task file, overlays it on defaultConfig(), validates required
 * task fields, normalizes profiles through ProfileLoader, and returns the
 * normalized TaskConfig plus session metadata. Keep this parser structural;
 * role semantics should live in prompts/config, not code.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import type { TaskConfig, WorkerConfig, WorkerName, SubagentProfile, SchedulerConfig } from "../agent/types.js";
import { DEFAULT_SCHEDULER } from "../agent/types.js";
import { defaultConfig } from "./default-config.js";
import { normalizeProfile } from "./profile-loader.js";
import { injectAgents, type InjectionOptions } from "./agent-loader.js";
import { configFile } from "./peak-home.js";

export interface LoadConfigOptions extends InjectionOptions {
  /** Skip merging ~/.peak/config.json baseline (testing). */
  skipBaseline?: boolean;
}

export interface LoadedConfig {
  config: TaskConfig;
  session: string;
  sessionDir: string;
  configPath: string;
}

export function loadConfig(configPath: string, sessionOverride?: string, opts: LoadConfigOptions = {}): LoadedConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    throw new Error(`task config not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`task config is not valid JSON: ${(err as Error).message}`);
  }

  // Start from defaultConfig(), then overlay the global ~/.peak/config.json
  // baseline (if present), then the task file itself.
  const base = defaultConfig();
  const baseline = opts.skipBaseline ? undefined : readBaselineConfig();
  const config = mergeConfig(base, baseline ?? {}, parsed);

  // New: `agents` is an array of names referencing ~/.peak/agents/<name>.json.
  // Each is a patch injected into its declared builtin slot. (The legacy
  // rejection of `agents` as a removed field is lifted — it now means injection.)
  const agentNames = parseAgentRefs(parsed);
  if (agentNames.length > 0) {
    const injected = injectAgents(config.profiles, agentNames, opts);
    config.profiles = injected.profiles;
    // Agent-provided workers go UNDER the task's own workers (task wins).
    config.workers = { ...injected.workers, ...config.workers };
  }

  if (!config.task.target) {
    throw new Error("task.target is required in task config");
  }
  if (!config.task.goal) {
    throw new Error("task.goal is required in task config");
  }

  const session = sessionOverride ?? config.task.session ?? deriveSessionFromTarget(config.task.target) ?? deriveSessionName(absPath);
  const sessionDir = dirname(absPath);

  return { config, session, sessionDir, configPath: absPath };
}

/** Read ~/.peak/config.json if it exists; return undefined otherwise. */
function readBaselineConfig(): Record<string, unknown> | undefined {
  const path = configFile();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed baseline is ignored — task config still loads.
  }
  return undefined;
}

/** `agents` must be a string array; anything else is ignored (legacy safe). */
function parseAgentRefs(parsed: Record<string, unknown>): string[] {
  const v = parsed.agents;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Derive a session name from the task target (e.g. "app.apk" -> "app"). */
function deriveSessionFromTarget(target: string): string | undefined {
  if (!target) return undefined;
  const base = basename(target.replace(/[\\/]/g, "/"));
  const stem = base.replace(/\.[^.]+$/, "");
  const safe = stem.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || undefined;
}

/**
 * Merge config layers: defaultConfig (base) ← ~/.peak/config.json (baseline)
 * ← task.json (override). Each layer overlays the one below; task fields win
 * over baseline, baseline over defaults.
 */
function mergeConfig(
  base: TaskConfig,
  baseline: Record<string, unknown>,
  override: Record<string, unknown>,
): TaskConfig {
  // Effective per-layer worker sources: baseline workers go under task workers.
  const baselineWorkers = recordValue(baseline, "workers");
  const mergedWorkers = baselineWorkers
    ? mergeWorkers(base.workers, baselineWorkers)
    : base.workers;

  const profilesRaw = recordValue(override, "profiles");
  const profiles: Record<string, SubagentProfile> = { ...base.profiles };

  // Always normalize every profile (base defaults included) so the structured
  // shape is guaranteed downstream even when task.json omits a profile.
  const profileIds = new Set<string>([
    "planner", "explorer", "evaluator", "metacog",
    ...(profilesRaw ? Object.keys(profilesRaw) : []),
  ]);
  for (const id of profileIds) {
    const raw = profilesRaw?.[id] ?? base.profiles[id];
    if (raw === undefined) continue;
    profiles[id] = normalizeProfile(id, raw);
  }

  // BuiltinProfiles requires planner/explorer/evaluator keys. Fill any gap
  // from defaults so the structured contract always holds.
  const result: TaskConfig = {
    task: {
      target: stringValue(override, "task.target") ?? stringValue(baseline, "task.target") ?? base.task.target,
      goal: stringValue(override, "task.goal") ?? stringValue(baseline, "task.goal") ?? base.task.goal,
      session: stringValue(override, "task.session") ?? stringValue(baseline, "task.session") ?? base.task.session,
      name: stringValue(override, "task.name") ?? stringValue(baseline, "task.name") ?? base.task.name,
    },
    profiles: {
      ...base.profiles,
      ...profiles,
    } as TaskConfig["profiles"],
    workers: mergeWorkers(mergedWorkers, recordValue(override, "workers")),
    scheduler: mergeScheduler(base.scheduler, { ...baseline, ...override }),
    control: mergeControl(
      mergeControl(base.control, recordValue(baseline, "control")),
      recordValue(override, "control"),
    ),
  };
  return result;
}

function mergeWorkers(
  base: Record<WorkerName, WorkerConfig>,
  override: Record<string, unknown> | undefined,
): Record<WorkerName, WorkerConfig> {
  if (!override) return base;
  const result: Record<WorkerName, WorkerConfig> = { ...base };
  for (const [name, raw] of Object.entries(override)) {
    const w = raw as Record<string, unknown>;
    if (!w) continue;
    result[name] = {
      kind: (stringValue(w, "kind") ?? "agent") as WorkerConfig["kind"],
      backend: stringValue(w, "backend"),
      transport: stringValue(w, "transport") as WorkerConfig["transport"],
      command: stringValue(w, "command"),
      args: Array.isArray(w.args) ? (w.args as string[]) : undefined,
      model: stringValue(w, "model"),
      baseUrl: stringValue(w, "baseUrl"),
      apiKeyEnv: stringValue(w, "apiKeyEnv"),
      password: stringValue(w, "password"),
      provider: stringValue(w, "provider"),
      maxTokens: numberValue(w, "maxTokens"),
      temperature: numberValue(w, "temperature"),
      timeoutMs: numberValue(w, "timeoutMs"),
    };
  }
  return result;
}

/**
 * Merge scheduler config. Accepts the new top-level `scheduler` shape and, for
 * backward compatibility, the legacy `workflow.limits` fields maxConcurrent /
 * refillPerTick / workerLeaseMs (the depth/stop/stagnation controls are ignored
 * — there is no depth limit and termination is natural).
 */
function mergeScheduler(
  base: SchedulerConfig | undefined,
  override: Record<string, unknown>,
): SchedulerConfig | undefined {
  const directRaw = recordValue(override, "scheduler");
  const legacyLimits = recordValue(recordValue(override, "workflow") ?? {}, "limits");

  const maxConcurrent =
    (directRaw ? numberValue(directRaw, "maxConcurrent") : undefined) ??
    (legacyLimits ? numberValue(legacyLimits, "maxConcurrent") : undefined) ??
    base?.maxConcurrent ?? DEFAULT_SCHEDULER.maxConcurrent;
  const refillPerTick =
    (directRaw ? numberValue(directRaw, "refillPerTick") : undefined) ??
    (legacyLimits ? numberValue(legacyLimits, "refillPerTick") : undefined) ??
    base?.refillPerTick ?? DEFAULT_SCHEDULER.refillPerTick;
  const workerLeaseMs =
    (directRaw ? numberValue(directRaw, "workerLeaseMs") : undefined) ??
    (legacyLimits ? numberValue(legacyLimits, "workerLeaseMs") : undefined) ??
    base?.workerLeaseMs ?? DEFAULT_SCHEDULER.workerLeaseMs;

  return { maxConcurrent, refillPerTick, workerLeaseMs };
}

function mergeControl(
  base: TaskConfig["control"],
  override: Record<string, unknown> | undefined,
): TaskConfig["control"] | undefined {
  if (!override) return base;
  return {
    mainProfile: stringValue(override, "mainProfile") ?? base?.mainProfile,
    metacogProfile: stringValue(override, "metacogProfile") ?? base?.metacogProfile,
    metacogIntervalSeconds: numberValue(override, "metacogIntervalSeconds") ?? base?.metacogIntervalSeconds,
    globalMaxConcurrent: numberValue(override, "globalMaxConcurrent") ?? base?.globalMaxConcurrent,
  };
}

function stringValue(obj: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : undefined;
}

function numberValue(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function recordValue(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function deriveSessionName(configPath: string): string {
  const parts = configPath.replace(/\\/g, "/").split("/");
  const dir = parts[parts.length - 2] ?? "session";
  return dir.replace(/[^a-zA-Z0-9_-]/g, "-");
}
