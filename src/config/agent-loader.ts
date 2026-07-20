/** Load one task-local role bundle from <task-dir>/<name>.json. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ContextSpec,
  PromptSpec,
  RetryPolicy,
  SessionRole,
  SubagentProfile,
  WorkerName,
} from "../agent/types.js";
import { BUILTIN_PERMISSIONS } from "../agent/types.js";
import { defaultConfig } from "./default-config.js";
import { assertSkillName } from "./task-skill-installer.js";
import { resolvePromptPaths } from "./prompt-loader.js";

const ROLES = new Set<SessionRole>(["planner", "explorer", "evaluator", "metacog"]);
const CONTRACTS = {
  planner: "main_decision",
  explorer: "candidate_fact",
  evaluator: "verdict",
  metacog: "hints",
} as const;

export interface AgentRoleConfig {
  role?: SessionRole;
  worker?: WorkerName;
  workers?: WorkerName[];
  prompt?: Partial<PromptSpec>;
  tools?: string[];
  skills?: string[];
  context?: Partial<ContextSpec>;
  maxActive?: number;
  cooldownSteps?: number;
  retry?: RetryPolicy;
}

export interface AgentFile {
  roles: Record<string, AgentRoleConfig>;
}

export function loadAgent(
  name: string,
  taskDir: string,
): Record<string, SubagentProfile> {
  assertAgentName(name);
  const path = join(taskDir, `${name}.json`);
  if (!existsSync(path)) throw new Error(`agent config not found: ${name} (looked for ${path})`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`agent config "${name}" is not valid JSON: ${(error as Error).message}`);
  }
  const root = objectValue(parsed, `agent config "${name}"`);
  assertKeys(root, ["roles"], `agent config "${name}"`);
  const roles = objectValue(root.roles, `agent config "${name}".roles`);
  if (Object.keys(roles).length === 0) throw new Error(`agent config "${name}".roles cannot be empty`);

  const native = defaultConfig().profiles;
  const profiles: Record<string, SubagentProfile> = {};
  for (const [profileId, raw] of Object.entries(roles)) {
    const label = `agent role "${profileId}"`;
    const roleConfig = objectValue(raw, label);
    assertKeys(roleConfig, [
      "role", "worker", "workers", "prompt", "tools", "skills", "context",
      "maxActive", "cooldownSteps", "retry",
    ], label);
    const patch = parseRoleConfig(roleConfig, label);
    const role = resolveRole(profileId, patch.role);
    const base = native[role];
    if (!base) throw new Error(`native role config missing: ${role}`);
    profiles[profileId] = mergeRole(base, role, patch, dirname(path));
  }
  for (const role of ROLES) {
    if (!Object.values(profiles).some((profile) => profile.role === role)) {
      profiles[role] = native[role]!;
    }
  }
  validateInitialRoles(profiles);
  return profiles;
}

function mergeRole(
  base: SubagentProfile,
  role: SessionRole,
  patch: AgentRoleConfig,
  baseDir: string,
): SubagentProfile {
  const promptPatch = patch.prompt ? resolvePromptPaths(stripUndefined(patch.prompt), baseDir) : undefined;
  const skills = patch.skills?.map((value) => {
    assertSkillName(value);
    return value;
  });
  const profile: SubagentProfile = {
    role,
    runtime: {
      worker: patch.worker ?? base.runtime.worker,
      ...(patch.workers ? { workers: uniqueStrings(patch.workers, "workers") } : {}),
    },
    prompt: {
      ...base.prompt,
      ...promptPatch,
      ...(skills ? { skills } : promptPatch?.skills ? {} : base.prompt.skills ? { skills: base.prompt.skills } : {}),
    },
    ...(patch.tools ? { tools: uniqueStrings(patch.tools, "tools") } : {}),
    context: { ...base.context, ...stripUndefined(patch.context ?? {}) },
    permissions: [...BUILTIN_PERMISSIONS[role]],
    output: { contract: CONTRACTS[role] },
  };
  for (const key of ["maxActive", "cooldownSteps"] as const) {
    const value = patch[key] ?? base[key];
    if (value !== undefined) profile[key] = value;
  }
  if (patch.retry ?? base.retry) profile.retry = { ...(base.retry ?? {}), ...stripUndefined(patch.retry ?? {}) };
  return profile;
}

function resolveRole(profileId: string, rawRole: unknown): SessionRole {
  const role = typeof rawRole === "string"
    ? rawRole
    : ROLES.has(profileId as SessionRole)
      ? profileId
      : undefined;
  if (!role || !ROLES.has(role as SessionRole)) {
    throw new Error(`agent role "${profileId}" must declare role as planner|explorer|evaluator|metacog`);
  }
  return role as SessionRole;
}

function parseRoleConfig(value: Record<string, unknown>, label: string): AgentRoleConfig {
  const prompt = value.prompt === undefined ? undefined : objectValue(value.prompt, `${label}.prompt`);
  if (prompt) assertKeys(prompt, ["file", "instructions", "rules", "knowledge"], `${label}.prompt`);
  const context = value.context === undefined ? undefined : objectValue(value.context, `${label}.context`);
  if (context) assertKeys(context, [
    "graphView", "maxFacts", "includeDeadEnds", "includeProgress", "relevanceScope",
  ], `${label}.context`);
  const retry = value.retry === undefined ? undefined : objectValue(value.retry, `${label}.retry`);
  if (retry) assertKeys(retry, ["maxAttempts", "backoffMs"], `${label}.retry`);
  return {
    role: optionalEnum(value.role, ["planner", "explorer", "evaluator", "metacog"], `${label}.role`),
    worker: optionalString(value.worker, `${label}.worker`),
    workers: optionalStringArray(value.workers, `${label}.workers`),
    prompt: prompt ? {
      file: optionalString(prompt.file, `${label}.prompt.file`),
      instructions: optionalString(prompt.instructions, `${label}.prompt.instructions`),
      rules: optionalStringArray(prompt.rules, `${label}.prompt.rules`),
      knowledge: optionalStringArray(prompt.knowledge, `${label}.prompt.knowledge`),
    } : undefined,
    tools: optionalStringArray(value.tools, `${label}.tools`),
    skills: optionalStringArray(value.skills, `${label}.skills`),
    context: context ? {
      graphView: optionalEnum(context.graphView, ["full", "focused", "evidence-only", "summary"], `${label}.context.graphView`),
      maxFacts: optionalPositiveInt(context.maxFacts, `${label}.context.maxFacts`),
      includeDeadEnds: optionalBoolean(context.includeDeadEnds, `${label}.context.includeDeadEnds`),
      includeProgress: optionalBoolean(context.includeProgress, `${label}.context.includeProgress`),
      relevanceScope: optionalEnum(context.relevanceScope, ["linked", "all"], `${label}.context.relevanceScope`),
    } as Partial<ContextSpec> : undefined,
    maxActive: optionalPositiveInt(value.maxActive, `${label}.maxActive`),
    cooldownSteps: optionalNonNegativeInt(value.cooldownSteps, `${label}.cooldownSteps`),
    retry: retry ? {
      maxAttempts: optionalPositiveInt(retry.maxAttempts, `${label}.retry.maxAttempts`),
      backoffMs: optionalNonNegativeInt(retry.backoffMs, `${label}.retry.backoffMs`),
    } : undefined,
  };
}

function validateInitialRoles(profiles: Record<string, SubagentProfile>): void {
  for (const role of ROLES) {
    if (!Object.values(profiles).some((profile) => profile.role === role)) {
      throw new Error(`agent config must provide an initial ${role} role`);
    }
  }
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function assertAgentName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error("agent name must contain only letters, digits, underscore, or hyphen and must not contain a path");
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  return uniqueStrings(value, label);
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  const parsed = optionalString(value, label);
  if (parsed === undefined) return undefined;
  if (!allowed.includes(parsed as T)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  return parsed as T;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  const parsed = optionalNonNegativeInt(value, label);
  if (parsed === 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function optionalNonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown) throw new Error(`${label} contains unknown field "${unknown}"`);
}
